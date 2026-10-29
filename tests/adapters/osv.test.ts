import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { scanOsv } from "../../src/adapters/osv.ts";
import { OSV_DB_ENV, TOOLS } from "../../src/adapters/tools.ts";
import { createFakeTool, type FakeTool } from "./helpers/fake-tool.ts";

let fake: FakeTool;
let snapshot: string;
let dbDir: string;

const VULN_JSON = JSON.stringify({
  results: [
    {
      source: { path: "/snap/package-lock.json", type: "lockfile" },
      packages: [
        {
          package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
          groups: [{ ids: ["GHSA-35jh-r3h4-6jhm"] }],
          vulnerabilities: [
            { id: "GHSA-35jh-r3h4-6jhm", summary: "Command Injection in lodash", aliases: ["CVE-2021-23337"] },
            { id: "GHSA-29mw-wpgm-hmr9", summary: "ReDoS in lodash" },
          ],
        },
      ],
    },
  ],
});

before(async () => {
  fake = await createFakeTool("fake-osv-scanner", { version: "osv-scanner version: 2.7.0", stdout: VULN_JSON, exitCode: 1 });
  snapshot = await mkdtemp(join(tmpdir(), "guardia-snap "));
  await writeFile(join(snapshot, "package-lock.json"), "{}");
  await mkdir(join(snapshot, "sub dir"));
  await writeFile(join(snapshot, "sub dir", "requirements.txt"), "x==1");
  await writeFile(join(snapshot, "Gemfile.lock"), "");
  dbDir = await mkdtemp(join(tmpdir(), "guardia-osvdb-"));
  await mkdir(join(dbDir, "osv-scalibr", "npm"), { recursive: true });
  await writeFile(join(dbDir, "osv-scalibr", "npm", "all.zip"), "not-a-real-zip");
  await writeFile(join(dbDir, "guardia-db-meta.json"), JSON.stringify({ databases: { npm: { downloadedAt: "2026-10-29T06:02:15Z" } } }));
});
after(async () => {
  await fake.cleanup();
  await rm(snapshot, { recursive: true, force: true });
  await rm(dbDir, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: "/x", [TOOLS.osv.envBin]: fake.path, [OSV_DB_ENV]: dbDir };
}

test("[simulation] exit 1 with vulnerabilities maps to ok with findings and database metadata", async () => {
  await fake.setScenario({ version: "osv-scanner version: 2.7.0", stdout: VULN_JSON, exitCode: 1 });
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["package-lock.json"] }, { env: env() });
  assert.equal(r.status, "ok");
  assert.equal(r.scanner, "osv");
  assert.equal(r.version, "2.7.0");
  assert.deepEqual(r.filesAnalyzed, ["package-lock.json"]);
  assert.equal(r.findings.length, 2);
  assert.deepEqual(r.findings[0], {
    scanner: "osv", type: "dependency", id: "GHSA-35jh-r3h4-6jhm", path: "package-lock.json",
    summary: "lodash@4.17.20: Command Injection in lodash",
  });
  assert.equal(r.database?.downloadedAt, "2026-10-29T06:02:15Z");
  assert.equal(r.database?.sourceDate, null);
  assert.match(r.database?.sha256 ?? "", /^[0-9a-f]{64}$/);
  const argv = await fake.argv();
  assert.deepEqual(argv, ["scan", "--offline", "--format", "json", "-L", join(snapshot, "package-lock.json")]);
});

test("[simulation] exit 0 with empty results maps to ok with no findings", async () => {
  await fake.setScenario({ version: "osv-scanner version: 2.7.0", stdout: '{"results":[]}', exitCode: 0 });
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["package-lock.json"] }, { env: env() });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.filesAnalyzed, ["package-lock.json"]);
});

test("[simulation] exit 128 maps to unsupported with the lockfile omitted", async () => {
  await fake.setScenario({ version: "osv-scanner version: 2.7.0", stderr: "No package sources found", exitCode: 128 });
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["package-lock.json"] }, { env: env() });
  assert.equal(r.status, "unsupported");
  assert.deepEqual(r.filesAnalyzed, []);
  assert.ok(r.omitted.some((o) => o.includes("package-lock.json")));
});

test("[simulation] exit 127 with unknown stderr maps to error without leaking stderr", async () => {
  await fake.setScenario({ version: "osv-scanner version: 2.7.0", stderr: "SECRET-IN-STDERR-7d9f", exitCode: 127 });
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["package-lock.json"] }, { env: env() });
  assert.equal(r.status, "error");
  assert.ok(r.error);
  assert.ok(!JSON.stringify(r).includes("SECRET-IN-STDERR-7d9f"));
});

test("[simulation] invalid JSON on exit 0 maps to error, never to a clean result", async () => {
  await fake.setScenario({ version: "osv-scanner version: 2.7.0", stdout: "not json {", exitCode: 0 });
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["package-lock.json"] }, { env: env() });
  assert.equal(r.status, "error");
  assert.deepEqual(r.filesAnalyzed, []);
});

test("absent database file maps to missing without running the tool", async () => {
  const emptyDb = await mkdtemp(join(tmpdir(), "guardia-emptydb-"));
  try {
    await fake.setScenario({ version: "osv-scanner version: 2.7.0", stdout: "SHOULD-NOT-RUN" });
    const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["package-lock.json"] }, { env: { ...env(), [OSV_DB_ENV]: emptyDb } });
    assert.equal(r.status, "missing");
    assert.deepEqual(r.filesAnalyzed, []);
    assert.equal(r.database?.sha256, null);
    assert.notDeepEqual(await fake.argv(), ["scan", "--offline", "--format", "json", "-L", join(snapshot, "package-lock.json")]);
  } finally {
    await rm(emptyDb, { recursive: true, force: true });
  }
});

test("missing executable maps to missing", async () => {
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["package-lock.json"] }, { env: { ...env(), [TOOLS.osv.envBin]: "/nonexistent/osv-scanner" } });
  assert.equal(r.status, "missing");
  assert.equal(r.version, null);
  assert.deepEqual(r.findings, []);
});

test("[simulation] unsupported lockfile name is omitted and never passed to the tool", async () => {
  await fake.setScenario({ version: "osv-scanner version: 2.7.0", stdout: '{"results":[]}', exitCode: 0 });
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["Gemfile.lock", "package-lock.json"] }, { env: env() });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.filesAnalyzed, ["package-lock.json"]);
  assert.ok(r.omitted.some((o) => o.includes("Gemfile.lock")));
});

test("lockfile escaping the snapshot is rejected before execution", async () => {
  await fake.setScenario({ version: "osv-scanner version: 2.7.0", stdout: "SHOULD-NOT-RUN", exitCode: 0 });
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["../package-lock.json", "/etc/package-lock.json"] }, { env: env() });
  assert.equal(r.status, "error");
  assert.deepEqual(r.filesAnalyzed, []);
  assert.equal(r.omitted.length, 2);
  const argv = await fake.argv();
  assert.ok(!(argv ?? []).some((a) => a.includes("/etc/") || a.includes("..")));
});

test("[simulation] version mismatch is recorded in omitted but does not fail the scan", async () => {
  await fake.setScenario({ version: "osv-scanner version: 2.6.0", stdout: '{"results":[]}', exitCode: 0 });
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["package-lock.json"] }, { env: env() });
  assert.equal(r.status, "ok");
  assert.equal(r.version, "2.6.0");
  assert.ok(r.omitted.some((o) => o.includes("2.6.0") && o.includes("2.7.0")));
});

test("empty lockfile list is unsupported, not ok", async () => {
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: [] }, { env: env() });
  assert.equal(r.status, "unsupported");
  assert.deepEqual(r.findings, []);
});
