/**
 * Real-binary checks. Opt in with GUARDIA_INTEGRATION=1 and make the pinned
 * tools reachable (GUARDIA_*_BIN or PATH) with the npm database downloaded as
 * described in docs/scanners.md. Everything else in tests/adapters simulates.
 */
import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { scanAll } from "../../src/adapters/index.ts";
import { scanGitleaks } from "../../src/adapters/gitleaks.ts";
import { scanOsv } from "../../src/adapters/osv.ts";
import { INTEGRATION_ENV } from "../../src/adapters/tools.ts";

const enabled = process.env[INTEGRATION_ENV] === "1";
const FIXTURES = resolve(import.meta.dirname, "..", "..", "fixtures", "adapters");
let snapshot: string;

before(async () => {
  if (!enabled) return;
  snapshot = await mkdtemp(join(tmpdir(), "guardia-int snap-"));
  await cp(FIXTURES, snapshot, { recursive: true });
});
after(async () => {
  if (enabled) await rm(snapshot, { recursive: true, force: true });
});

test("[integration] osv-scanner 2.7.0 reports the known lodash advisory offline", { skip: !enabled }, async () => {
  const r = await scanOsv({ snapshotDir: snapshot, lockfiles: ["npm-vulnerable/package-lock.json", "npm-clean/package-lock.json"] });
  assert.equal(r.status, "ok", r.error);
  assert.equal(r.version, "2.7.0");
  assert.deepEqual(r.filesAnalyzed, ["npm-vulnerable/package-lock.json", "npm-clean/package-lock.json"]);
  assert.ok(r.findings.some((f) => f.id === "GHSA-35jh-r3h4-6jhm" && f.path === "npm-vulnerable/package-lock.json"));
  assert.ok(r.findings.every((f) => f.path !== "npm-clean/package-lock.json"));
  assert.match(r.database?.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(r.database?.sourceDate, null);
});

test("[integration] osv-scanner with an empty database directory is missing, not clean", { skip: !enabled }, async () => {
  const emptyDb = await mkdtemp(join(tmpdir(), "guardia-int-emptydb-"));
  try {
    const r = await scanOsv(
      { snapshotDir: snapshot, lockfiles: ["npm-vulnerable/package-lock.json"] },
      { env: { ...process.env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: emptyDb } },
    );
    assert.equal(r.status, "missing");
    assert.deepEqual(r.findings, []);
  } finally {
    await rm(emptyDb, { recursive: true, force: true });
  }
});

test("[integration] gitleaks 8.30.1 finds both synthetic secrets and redacts them", { skip: !enabled }, async () => {
  const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] });
  assert.equal(r.status, "ok", r.error);
  assert.equal(r.version, "8.30.1");
  const byRule = new Map(r.findings.map((f) => [f.id, f]));
  assert.equal(byRule.get("github-pat")?.path, "secrets/config.py");
  assert.equal(byRule.get("github-pat")?.line, 4);
  assert.equal(byRule.get("aws-access-token")?.line, 5);
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes("ghp_GUARDIADEMO"));
  assert.ok(!serialized.includes("AKIAGUARDIA"));
  assert.ok(r.filesAnalyzed.includes("secrets/config.py"));
});

test("[integration] a hostile .gitleaks.toml in the snapshot does not silence gitleaks", { skip: !enabled }, async () => {
  await writeFile(join(snapshot, ".gitleaks.toml"), "[extend]\nuseDefault = true\n[allowlist]\npaths = ['''.*''']\n");
  try {
    const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] });
    assert.equal(r.status, "ok", r.error);
    assert.equal(r.findings.length, 2);
    assert.ok(r.omitted.some((o) => o.includes(".gitleaks.toml")));
  } finally {
    await rm(join(snapshot, ".gitleaks.toml"));
  }
});

test("[integration] inline gitleaks:allow comments do not silence findings", { skip: !enabled }, async () => {
  const target = join(snapshot, "secrets", "config.py");
  const original = await readFile(target, "utf8");
  await writeFile(target, original.replace(/\n(?=DEMO_AWS)/, "  # gitleaks:allow\n").replace(/"\n$/, '"  # gitleaks:allow\n'));
  try {
    const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] });
    assert.equal(r.status, "ok", r.error);
    assert.equal(r.findings.length, 2);
  } finally {
    await writeFile(target, original);
  }
});

test("[integration] a root .gitleaksignore is reported as error, never as a clean scan", { skip: !enabled }, async () => {
  const fp = join(snapshot, "secrets", "config.py");
  await appendFile(join(snapshot, ".gitleaksignore"), `${fp}:github-pat:4\n${fp}:aws-access-token:5\n`);
  try {
    const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] });
    assert.equal(r.status, "error");
    assert.ok(r.omitted.some((o) => o.includes(".gitleaksignore")));
  } finally {
    await rm(join(snapshot, ".gitleaksignore"));
  }
});

test("[integration] scanAll returns one result per scanner", { skip: !enabled }, async () => {
  const results = await scanAll({ snapshotDir: snapshot, lockfiles: ["npm-vulnerable/package-lock.json"] });
  assert.deepEqual(results.map((r) => r.scanner), ["osv", "gitleaks"]);
  assert.ok(results.every((r) => r.status === "ok"));
});
