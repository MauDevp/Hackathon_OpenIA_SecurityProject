import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { runTool } from "../../src/adapters/runner.ts";
import { TOOLS } from "../../src/adapters/tools.ts";
import { createFakeTool, type FakeTool } from "./helpers/fake-tool.ts";

let fake: FakeTool;
const SECRET_MARKER = "ghp_RUNNERTESTVALUESHOULDNEVERLEAK000000";

before(async () => {
  fake = await createFakeTool("fake-osv-scanner");
});
after(() => fake.cleanup());

function env(binPath: string | undefined): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: "/nonexistent-home" };
  if (binPath !== undefined) e[TOOLS.osv.envBin] = binPath;
  return e;
}

test("[simulation] completed run returns exit code and stdout", async () => {
  await fake.setScenario({ stdout: '{"results":[]}', exitCode: 1 });
  const r = await runTool("osv", ["scan"], { env: env(fake.path) });
  assert.equal(r.kind, "completed");
  if (r.kind !== "completed") return;
  assert.equal(r.exitCode, 1);
  assert.equal(r.stdout, '{"results":[]}');
  assert.deepEqual(await fake.argv(), ["scan"]);
});

test("missing executable (env override) is reported as missing, not as a clean run", async () => {
  const r = await runTool("osv", ["scan"], { env: env("/nonexistent/dir/osv-scanner") });
  assert.equal(r.kind, "missing");
});

test("missing executable (PATH lookup) is reported as missing", async () => {
  const r = await runTool("osv", ["scan"], { env: { PATH: "/nonexistent-bin", HOME: "/x" } });
  assert.equal(r.kind, "missing");
});

test("[simulation] timeout is reported as interrupted", async () => {
  await fake.setScenario({ sleepMs: 5_000, stdout: "partial" });
  const r = await runTool("osv", ["scan"], { env: env(fake.path), timeoutMs: 300 });
  assert.equal(r.kind, "interrupted");
});

test("[simulation] output over the cap is reported as output-too-large", async () => {
  await fake.setScenario({ stdoutBytes: 64 * 1024 });
  const r = await runTool("osv", ["scan"], { env: env(fake.path), maxOutputBytes: 4 * 1024 });
  assert.equal(r.kind, "output-too-large");
});

test("[simulation] failure outcomes never embed raw tool output", async () => {
  await fake.setScenario({ stdoutBytes: 64 * 1024, stderr: SECRET_MARKER });
  const r = await runTool("osv", ["scan"], { env: env(fake.path), maxOutputBytes: 1024 });
  assert.equal(r.kind, "output-too-large");
  assert.ok(!JSON.stringify(r).includes(SECRET_MARKER));
  assert.ok(!JSON.stringify(r).includes("xxxx"));
});

test("tool outside the closed list is rejected before anything runs", async () => {
  // Cast to defeat the type-level guard: the runtime guard must hold on its own.
  const r = await runTool("bash" as unknown as "osv", ["-c", "echo pwned"], { env: env(undefined) });
  assert.equal(r.kind, "rejected");
});

test("arguments containing NUL bytes are rejected", async () => {
  const r = await runTool("osv", ["scan", "a\u0000b"], { env: env(fake.path) });
  assert.equal(r.kind, "rejected");
});

test("[simulation] child receives only allowlisted environment variables", async () => {
  await fake.setScenario({ stdout: "ok" });
  const leaky = { ...env(fake.path), AWS_SECRET_ACCESS_KEY: "should-not-pass", OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: "/db" };
  const r = await runTool("osv", ["scan"], { env: leaky, extraEnv: ["OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY"] });
  assert.equal(r.kind, "completed");
  if (r.kind !== "completed") return;
  assert.deepEqual(r.envKeys.sort(), ["HOME", "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY", "PATH"]);
});
