import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { scanGitleaks } from "../../src/adapters/gitleaks.ts";
import { TOOLS } from "../../src/adapters/tools.ts";
import { createFakeTool, type FakeTool } from "./helpers/fake-tool.ts";

const FAKE_SECRET = "ghp_FAKEVALUETHATMUSTNEVERAPPEAR0000000000";
let fake: FakeTool;
let snapshot: string;

function report(snapshotDir: string): string {
  return JSON.stringify([
    {
      RuleID: "github-pat",
      Description: "Uncovered a GitHub Personal Access Token.",
      StartLine: 4, EndLine: 4, StartColumn: 23, EndColumn: 62,
      Match: `DEMO_GITHUB_TOKEN = "${FAKE_SECRET}"`,
      Secret: FAKE_SECRET,
      File: join(snapshotDir, "src", "config.py"),
      SymlinkFile: "", Commit: "", Entropy: 3.8, Author: "", Email: "", Date: "", Message: "", Tags: [],
      Fingerprint: `${join(snapshotDir, "src", "config.py")}:github-pat:4`,
    },
  ]);
}

before(async () => {
  fake = await createFakeTool("fake-gitleaks", { version: "8.30.1" });
  snapshot = await mkdtemp(join(tmpdir(), "guardia-gl snap-"));
  await mkdir(join(snapshot, "src"));
  await writeFile(join(snapshot, "src", "config.py"), `DEMO_GITHUB_TOKEN = "${FAKE_SECRET}"\n`);
  await writeFile(join(snapshot, "README.md"), "hello\n");
});
after(async () => {
  await fake.cleanup();
  await rm(snapshot, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: "/x", [TOOLS.gitleaks.envBin]: fake.path };
}

test("[simulation] a redacted finding keeps rule, file and line and drops the secret", async () => {
  await fake.setScenario({ version: "8.30.1", report: report(snapshot), stderr: `leak: ${FAKE_SECRET}`, exitCode: 0 });
  const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] }, { env: env() });
  assert.equal(r.status, "ok");
  assert.equal(r.version, "8.30.1");
  assert.deepEqual(r.findings, [{
    scanner: "gitleaks", type: "secret", id: "github-pat", path: "src/config.py", line: 4,
    summary: "Uncovered a GitHub Personal Access Token.",
  }]);
  assert.deepEqual(r.filesAnalyzed.sort(), ["README.md", "src/config.py"]);
  assert.ok(!JSON.stringify(r).includes(FAKE_SECRET));
  const argv = (await fake.argv()) ?? [];
  assert.equal(argv[0], "dir");
  assert.equal(argv[1], snapshot);
  assert.ok(argv.includes("--config"));
  assert.ok(argv[argv.indexOf("--config") + 1]?.endsWith("rules/gitleaks/guardia.toml"));
  for (const flag of ["--report-format", "--report-path", "--redact", "--no-banner", "--no-color", "--exit-code", "--ignore-gitleaks-allow", "--gitleaks-ignore-path"]) {
    assert.ok(argv.includes(flag), `missing ${flag}`);
  }
  assert.equal(argv[argv.indexOf("--exit-code") + 1], "0");
  assert.ok(!argv[argv.indexOf("--report-path") + 1]?.startsWith(snapshot), "report must be written outside the snapshot");
  const ignorePath = argv[argv.indexOf("--gitleaks-ignore-path") + 1] ?? "";
  assert.ok(ignorePath !== "." && !ignorePath.startsWith(snapshot), "ignore file must not come from cwd or the snapshot");
});

test("[simulation] exit 1 is an execution error, never findings or a clean result", async () => {
  await fake.setScenario({ version: "8.30.1", report: "[]", exitCode: 1, stderr: "ERR something" });
  const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] }, { env: env() });
  assert.equal(r.status, "error");
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.filesAnalyzed, []);
});

test("[simulation] invalid report JSON maps to error", async () => {
  await fake.setScenario({ version: "8.30.1", report: "[{broken", exitCode: 0 });
  const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] }, { env: env() });
  assert.equal(r.status, "error");
  assert.deepEqual(r.filesAnalyzed, []);
});

test("[simulation] missing report file on exit 0 maps to error", async () => {
  await fake.setScenario({ version: "8.30.1", exitCode: 0 });
  const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] }, { env: env() });
  assert.equal(r.status, "error");
});

test("missing executable maps to missing", async () => {
  const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] }, { env: { ...env(), [TOOLS.gitleaks.envBin]: "/nonexistent/gitleaks" } });
  assert.equal(r.status, "missing");
  assert.equal(r.version, null);
});

test("[simulation] a .gitleaks.toml in the snapshot is ignored and recorded in omitted", async () => {
  await writeFile(join(snapshot, ".gitleaks.toml"), "[allowlist]\npaths = ['''.*''']\n");
  try {
    await fake.setScenario({ version: "8.30.1", report: "[]", exitCode: 0 });
    const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] }, { env: env() });
    assert.equal(r.status, "ok");
    assert.ok(r.omitted.some((o) => o.includes(".gitleaks.toml")));
    const argv = (await fake.argv()) ?? [];
    assert.ok(!argv[argv.indexOf("--config") + 1]?.includes(snapshot));
  } finally {
    await rm(join(snapshot, ".gitleaks.toml"));
  }
});

test("[simulation] symlinks in the snapshot are listed as omitted, not analyzed", async () => {
  const outside = await mkdtemp(join(tmpdir(), "guardia-outside-"));
  await writeFile(join(outside, "leak.py"), "x\n");
  await symlink(join(outside, "leak.py"), join(snapshot, "link.py"));
  await symlink(outside, join(snapshot, "linkdir"));
  try {
    await fake.setScenario({ version: "8.30.1", report: "[]", exitCode: 0 });
    const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] }, { env: env() });
    assert.equal(r.status, "ok");
    assert.ok(!r.filesAnalyzed.includes("link.py"));
    assert.ok(!r.filesAnalyzed.some((f) => f.startsWith("linkdir")));
    assert.ok(r.omitted.some((o) => o.includes("link.py")));
    assert.ok(r.omitted.some((o) => o.includes("linkdir")));
  } finally {
    await rm(join(snapshot, "link.py"));
    await rm(join(snapshot, "linkdir"));
    await rm(outside, { recursive: true, force: true });
  }
});

test("nonexistent or relative snapshot is an error and the tool never runs", async () => {
  await fake.setScenario({ version: "8.30.1", report: report(snapshot), exitCode: 0 });
  const missing = await scanGitleaks({ snapshotDir: join(snapshot, "nope"), lockfiles: [] }, { env: env() });
  assert.equal(missing.status, "error");
  const relative = await scanGitleaks({ snapshotDir: "relative/path", lockfiles: [] }, { env: env() });
  assert.equal(relative.status, "error");
  assert.deepEqual(relative.findings, []);
});

test("[simulation] report entry pointing outside the snapshot is dropped and noted", async () => {
  const hostile = JSON.stringify([{ RuleID: "x", Description: "d", StartLine: 1, File: "/etc/passwd", Match: "m", Secret: "s" }]);
  await fake.setScenario({ version: "8.30.1", report: hostile, exitCode: 0 });
  const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] }, { env: env() });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.findings, []);
  assert.ok(r.omitted.some((o) => o.includes("outside the snapshot")));
});

test("[simulation] a root .gitleaksignore keeps findings but downgrades the status to error", async () => {
  await writeFile(join(snapshot, ".gitleaksignore"), "whatever:github-pat:4\n");
  try {
    await fake.setScenario({ version: "8.30.1", report: report(snapshot), exitCode: 0 });
    const r = await scanGitleaks({ snapshotDir: snapshot, lockfiles: [] }, { env: env() });
    assert.equal(r.status, "error");
    assert.equal(r.findings.length, 1);
    assert.ok(r.omitted.some((o) => o.includes(".gitleaksignore")));
    const argv = (await fake.argv()) ?? [];
    assert.ok(argv.includes("--ignore-gitleaks-allow"));
  } finally {
    await rm(join(snapshot, ".gitleaksignore"));
  }
});
