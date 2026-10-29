import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { cleanupSnapshot, createIndexSnapshot } from "../../src/core/snapshot.js";

const execFile = promisify(execFileCallback);

async function git(repository: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repository, ...args], { encoding: "utf8" });
  return result.stdout;
}

test("creates a read-only snapshot of staged changes without creating a commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "dmsecurity-index-"));
  const repository = join(root, "repository");
  try {
    await mkdir(repository);
    await git(repository, ["init", "--quiet"]);
    await git(repository, ["config", "user.email", "test@example.invalid"]);
    await git(repository, ["config", "user.name", "DMsecurity test"]);
    await writeFile(join(repository, "README.md"), "base\n");
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "--quiet", "-m", "base"]);

    await writeFile(join(repository, "staged.txt"), "staged content\n");
    await git(repository, ["add", "staged.txt"]);
    const before = await git(repository, ["status", "--porcelain"]);
    const snapshot = await createIndexSnapshot(repository);
    try {
      assert.equal(snapshot.commit, null);
      assert.equal(await readFile(join(snapshot.snapshotDir, "staged.txt"), "utf8"), "staged content\n");
      assert.equal(await git(repository, ["status", "--porcelain"]), before);
    } finally {
      await cleanupSnapshot(snapshot);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
