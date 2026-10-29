import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { main } from "../../src/cli/index.js";

const execFile = promisify(execFileCallback);

test("hook install is explicit and refuses to overwrite an existing hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "dmsecurity-hook-"));
  const repository = join(root, "repository");
  try {
    await mkdir(repository);
    await execFile("git", ["-C", repository, "init", "--quiet"], { encoding: "utf8" });
    assert.equal(
      await main([
        "hook", "install", "--repo", repository, "--mode", "warn", "--notify", "whatsapp", "--on", "pass,findings,incomplete",
      ]),
      0,
    );
    const hook = await readFile(join(repository, ".git", "hooks", "pre-commit"), "utf8");
    assert.match(hook, /--mode 'warn'/);
    assert.match(hook, /--notify 'whatsapp'/);
    assert.match(hook, /--on 'pass,findings,incomplete'/);
    assert.match(hook, /DMSECURITY_NODE_BIN=/);
    assert.equal(await main(["hook", "install", "--repo", repository]), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
