import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ScanAll } from "../../src/contracts.js";
import { executeScan, parseArguments } from "../../src/cli/index.js";

const execFile = promisify(execFileCallback);

async function git(repository: string, args: string[]): Promise<void> {
  await execFile("git", ["-C", repository, ...args], { encoding: "utf8" });
}

test("parser rejects unknown options and requires scan inputs", () => {
  assert.throws(() => parseArguments(["scan", "--repo", "/repo"]), /--ref is required/);
  assert.throws(() => parseArguments(["scan", "--unknown"]), /Unknown option/);
  assert.deepEqual(
    parseArguments(["scan", "--repo", "/repo", "--ref", "HEAD", "--out", "/tmp/report.json", "--strict-offline"]),
    { repo: "/repo", ref: "HEAD", out: "/tmp/report.json", strictOffline: true },
  );
});

test("writes an external JSON report with an injected scanner contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "guardia cli test "));
  const repository = join(root, "input repository");
  const output = join(root, "external", "report.json");
  const fakeScanAll: ScanAll = async () => [
    { scanner: "osv", status: "ok", version: "test", filesAnalyzed: ["package-lock.json"], omitted: [], findings: [] },
    { scanner: "gitleaks", status: "ok", version: "test", filesAnalyzed: [], omitted: [], findings: [] },
  ];
  try {
    await mkdir(repository);
    await git(repository, ["init", "--quiet"]);
    await git(repository, ["config", "user.email", "guardia@example.invalid"]);
    await git(repository, ["config", "user.name", "Guardia test"]);
    await writeFile(join(repository, "package-lock.json"), "{\"lockfileVersion\":3,\"packages\":{}}\n");
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const { result } = await executeScan(
      { repo: repository, ref: "HEAD", out: output, strictOffline: false },
      { scanAll: fakeScanAll },
    );
    assert.equal(result.status, "PASS");
    const report = JSON.parse(await readFile(output, "utf8")) as { status: string; commit: string };
    assert.equal(report.status, "PASS");
    assert.match(report.commit, /^[0-9a-f]{40}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
