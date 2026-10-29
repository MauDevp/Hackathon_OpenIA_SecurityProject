import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertOutputOutsideRepository,
  cleanupSnapshot,
  createSnapshot,
  isSafeRelativePath,
  SnapshotError,
} from "../../src/core/snapshot.js";

const execFile = promisify(execFileCallback);

async function git(repository: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repository, ...args], { encoding: "utf8" });
  return result.stdout;
}

async function makeRepository(): Promise<{ root: string; repository: string }> {
  const root = await mkdtemp(join(tmpdir(), "guardia test "));
  const repository = join(root, "repo with spaces");
  await mkdir(repository);
  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.email", "guardia@example.invalid"]);
  await git(repository, ["config", "user.name", "Guardia test"]);
  await writeFile(join(repository, "package-lock.json"), "{\"lockfileVersion\":3,\"packages\":{}}\n");
  await writeFile(join(repository, "README.md"), "synthetic fixture\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "--quiet", "-m", "initial"]);
  return { root, repository };
}

test("creates an immutable commit snapshot without changing a repository path with spaces", async () => {
  const { root, repository } = await makeRepository();
  try {
    const before = await git(repository, ["status", "--porcelain"]);
    const expectedCommit = (await git(repository, ["rev-parse", "HEAD"])).trim();
    const snapshot = await createSnapshot(repository, "HEAD");
    try {
      assert.equal(snapshot.commit, expectedCommit);
      assert.deepEqual(snapshot.lockfiles, ["package-lock.json"]);
      assert.equal(await readFile(join(snapshot.snapshotDir, "README.md"), "utf8"), "synthetic fixture\n");
      assert.equal(await git(repository, ["status", "--porcelain"]), before);
    } finally {
      await cleanupSnapshot(snapshot);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid references and output paths inside the target repository are rejected", async () => {
  const { root, repository } = await makeRepository();
  try {
    await assert.rejects(createSnapshot(repository, "does-not-exist"), SnapshotError);
    await assert.rejects(assertOutputOutsideRepository(repository, join(repository, "report.json")), SnapshotError);
    const output = await assertOutputOutsideRepository(repository, join(root, "reports", "report.json"));
    assert.match(output, /reports[\\/]report\.json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlinks are not materialized and unsafe relative paths are rejected", async () => {
  const { root, repository } = await makeRepository();
  const external = join(root, "external.txt");
  try {
    await writeFile(external, "outside\n");
    await symlink(external, join(repository, "escape-link"));
    await git(repository, ["add", "escape-link"]);
    await git(repository, ["commit", "--quiet", "-m", "symlink"]);
    const snapshot = await createSnapshot(repository, "HEAD");
    try {
      assert.equal(snapshot.complete, false);
      assert.ok(snapshot.excluded.some((entry) => entry.startsWith("escape-link:")));
      await assert.rejects(readFile(join(snapshot.snapshotDir, "escape-link")));
    } finally {
      await cleanupSnapshot(snapshot);
    }
    assert.equal(isSafeRelativePath("../outside"), false);
    assert.equal(isSafeRelativePath("/outside"), false);
    assert.equal(isSafeRelativePath("nested/package-lock.json"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
