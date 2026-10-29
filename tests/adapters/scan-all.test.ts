import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ScanAll, ScannerResult } from "../../src/adapters/contracts.ts";
import { createScanAll, scanAll } from "../../src/adapters/index.ts";
import { TOOLS } from "../../src/adapters/tools.ts";
import { createFakeTool, type FakeTool } from "./helpers/fake-tool.ts";

let osv: FakeTool;
let gitleaks: FakeTool;
let snapshot: string;

before(async () => {
  osv = await createFakeTool("fake-osv-scanner", { version: "osv-scanner version: 2.7.0", stdout: '{"results":[]}', exitCode: 0 });
  gitleaks = await createFakeTool("fake-gitleaks", { version: "8.30.1", report: "[]", exitCode: 0 });
  snapshot = await mkdtemp(join(tmpdir(), "guardia-all-"));
  await writeFile(join(snapshot, "package-lock.json"), "{}");
});
after(async () => {
  await osv.cleanup();
  await gitleaks.cleanup();
  await rm(snapshot, { recursive: true, force: true });
});

test("scanAll satisfies the shared ScanAll type", () => {
  const typed: ScanAll = scanAll;
  assert.equal(typeof typed, "function");
});

test("[simulation] scanAll returns osv then gitleaks, each with its own status", async () => {
  const emptyDb = await mkdtemp(join(tmpdir(), "guardia-all-db-"));
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "", HOME: "/x",
      [TOOLS.osv.envBin]: osv.path, [TOOLS.gitleaks.envBin]: gitleaks.path,
      OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: emptyDb,
    };
    const run = createScanAll({ env });
    const results = await run({ snapshotDir: snapshot, lockfiles: ["package-lock.json"] });
    assert.deepEqual(results.map((r) => r.scanner), ["osv", "gitleaks"]);
    assert.equal(results[0]?.status, "missing");
    assert.equal(results[1]?.status, "ok");
  } finally {
    await rm(emptyDb, { recursive: true, force: true });
  }
});

test("an adapter that throws becomes a sanitized error result, and the other scanner still reports", async () => {
  const boom = async (): Promise<ScannerResult> => {
    throw new Error("stack with secret ghp_SHOULDNOTLEAK0000000000000000000000000");
  };
  const fine = async (): Promise<ScannerResult> => ({ scanner: "gitleaks", status: "ok", version: "8.30.1", filesAnalyzed: [], omitted: [], findings: [] });
  const run = createScanAll({ adapters: { osv: boom, gitleaks: fine } });
  const results = await run({ snapshotDir: snapshot, lockfiles: [] });
  assert.equal(results.length, 2);
  assert.equal(results[0]?.scanner, "osv");
  assert.equal(results[0]?.status, "error");
  assert.ok(results[0]?.error);
  assert.ok(!JSON.stringify(results).includes("SHOULDNOTLEAK"));
  assert.equal(results[1]?.status, "ok");
});

test("an adapter resolving a result for the wrong scanner is replaced by an error", async () => {
  const wrong = async (): Promise<ScannerResult> => ({ scanner: "gitleaks", status: "ok", version: null, filesAnalyzed: [], omitted: [], findings: [] });
  const run = createScanAll({ adapters: { osv: wrong, gitleaks: wrong } });
  const results = await run({ snapshotDir: snapshot, lockfiles: [] });
  assert.equal(results[0]?.scanner, "osv");
  assert.equal(results[0]?.status, "error");
  assert.equal(results[1]?.status, "ok");
});
