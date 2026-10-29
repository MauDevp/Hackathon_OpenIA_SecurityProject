import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { createFakeTool, type FakeTool } from "./helpers/fake-tool.ts";

const run = promisify(execFile);
let tool: FakeTool;

before(async () => {
  tool = await createFakeTool("fake-scanner", { stdout: '{"ok":true}', version: "9.9.9" });
});
after(() => tool.cleanup());

test("[simulation] fake tool prints the scenario stdout and records argv", async () => {
  const { stdout } = await run(tool.path, ["scan", "-L", "a lock.json"]);
  assert.equal(stdout, '{"ok":true}');
  assert.deepEqual(await tool.argv(), ["scan", "-L", "a lock.json"]);
});

test("[simulation] fake tool answers --version and exits with the scenario code", async () => {
  const { stdout } = await run(tool.path, ["--version"]);
  assert.equal(stdout.trim(), "9.9.9");
  await tool.setScenario({ exitCode: 3, stderr: "boom" });
  await assert.rejects(run(tool.path, ["scan"]), (err: NodeJS.ErrnoException & { stderr?: string }) => {
    assert.equal(err.code, 3);
    assert.equal(err.stderr, "boom");
    return true;
  });
});
