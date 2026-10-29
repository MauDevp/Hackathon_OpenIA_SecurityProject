import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { scanGitleaks } from "../../src/adapters/gitleaks.ts";
import { scanOsv } from "../../src/adapters/osv.ts";
import { OSV_DB_ENV, TOOLS } from "../../src/adapters/tools.ts";
import { createFakeTool, type FakeTool } from "./helpers/fake-tool.ts";

let osv: FakeTool;
let gitleaks: FakeTool;
let snapshot: string;
let outside: string;
let dbDir: string;

before(async () => {
  osv = await createFakeTool("fake-osv-scanner", { version: "osv-scanner version: 2.7.0", stdout: '{"results":[]}', exitCode: 0 });
  gitleaks = await createFakeTool("fake-gitleaks", { version: "8.30.1", report: "[]", exitCode: 0 });
  snapshot = await mkdtemp(join(tmpdir(), "guardia adv snap-"));
  outside = await mkdtemp(join(tmpdir(), "guardia-adv-outside-"));
  await mkdir(join(snapshot, "deep dir", "x y"), { recursive: true });
  await writeFile(join(snapshot, "deep dir", "x y", "package-lock.json"), "{}");
  await writeFile(join(outside, "package-lock.json"), "{}");
  await symlink(join(outside, "package-lock.json"), join(snapshot, "yarn.lock"));
  await mkdir(join(snapshot, "pnpm-lock.yaml"));
  await mkdir(join(snapshot, "nested"));
  await writeFile(join(snapshot, "nested", ".gitleaks.toml"), "[allowlist]\npaths = ['''.*''']\n");
  dbDir = await mkdtemp(join(tmpdir(), "guardia-adv-db-"));
  await mkdir(join(dbDir, "osv-scalibr", "npm"), { recursive: true });
  await writeFile(join(dbDir, "osv-scalibr", "npm", "all.zip"), "zip");
});
after(async () => {
  await osv.cleanup();
  await gitleaks.cleanup();
  for (const d of [snapshot, outside, dbDir]) await rm(d, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "", HOME: "/x",
    [TOOLS.osv.envBin]: osv.path, [TOOLS.gitleaks.envBin]: gitleaks.path, [OSV_DB_ENV]: dbDir,
  };
}

test("[simulation] lockfile paths with spaces are passed verbatim as a single argument", async () => {
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["deep dir/x y/package-lock.json"] }, { env: env() });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.filesAnalyzed, ["deep dir/x y/package-lock.json"]);
  const argv = (await osv.argv()) ?? [];
  assert.equal(argv[argv.indexOf("-L") + 1], join(snapshot, "deep dir", "x y", "package-lock.json"));
});

test("a lockfile that is a symlink to a file outside the snapshot is rejected before execution", async () => {
  await osv.setScenario({ version: "osv-scanner version: 2.7.0", stdout: "MUST-NOT-RUN", exitCode: 0 });
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["yarn.lock"] }, { env: env() });
  assert.equal(r.status, "error");
  assert.deepEqual(r.filesAnalyzed, []);
  assert.ok(r.omitted.some((o) => o.includes("yarn.lock") && o.includes("escapes-snapshot")));
  const argv = (await osv.argv()) ?? [];
  assert.ok(!argv.includes("-L"), "scan must not have been invoked");
});

test("a lockfile path that is a directory is rejected", async () => {
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["pnpm-lock.yaml"] }, { env: env() });
  assert.equal(r.status, "error");
  assert.ok(r.omitted.some((o) => o.includes("not-a-file")));
});

test("lockfile paths with NUL bytes or traversal segments never reach the tool", async () => {
  await osv.setScenario({ version: "osv-scanner version: 2.7.0", stdout: "MUST-NOT-RUN", exitCode: 0 });
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["deep dir/../../package-lock.json", "a\u0000package-lock.json"] }, { env: env() });
  assert.equal(r.status, "error");
  assert.deepEqual(r.filesAnalyzed, []);
  const argv = (await osv.argv()) ?? [];
  assert.ok(!argv.includes("-L"));
});

test("[simulation] snapshot path with trailing slash and spaces works for gitleaks", async () => {
  const r = await scanGitleaks({ snapshotDir: `${snapshot}/`, lockfiles: [] }, { env: env() });
  assert.equal(r.status, "ok");
  assert.ok(r.filesAnalyzed.includes("deep dir/x y/package-lock.json"));
  const argv = (await gitleaks.argv()) ?? [];
  assert.equal(argv[1], snapshot);
});

test("[simulation] a nested .gitleaks.toml is reported as ignored", async () => {
  const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] }, { env: env() });
  assert.ok(r.omitted.some((o) => o.includes("nested/.gitleaks.toml")));
  assert.ok(r.omitted.some((o) => o.includes("yarn.lock") && o.includes("symlink")));
});

test("relative or empty env override for a binary is rejected instead of resolved against cwd", async () => {
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["deep dir/x y/package-lock.json"] }, { env: { ...env(), [TOOLS.osv.envBin]: "./.guardia/tools/osv-scanner" } });
  assert.equal(r.status, "error");
  assert.match(r.error ?? "", /env-override-not-absolute/);
});
