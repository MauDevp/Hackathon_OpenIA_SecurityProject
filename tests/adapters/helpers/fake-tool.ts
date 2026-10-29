import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Behaviour of a fake scanner executable. Tests that use it are simulations:
 * they prove how the adapter reacts to a given tool output, not that the real
 * tool produces it. Real-tool checks live in integration.test.ts.
 */
export interface FakeToolScenario {
  /** Printed to stdout (after `--version`/`version` handling). */
  stdout?: string;
  /** Printed to stderr. */
  stderr?: string;
  /** Process exit code. Default 0. */
  exitCode?: number;
  /** Printed when argv contains `--version` or `version`; exits 0. */
  version?: string;
  /** Written to the file named after `--report-path`, when present. */
  report?: string;
  /** Sleep before exiting, to trigger adapter timeouts. */
  sleepMs?: number;
  /** Emit this many bytes of filler to stdout instead of `stdout`. */
  stdoutBytes?: number;
}

export interface FakeTool {
  /** Absolute path of the executable. Inject it via GUARDIA_*_BIN. */
  path: string;
  /** Argument vector the last invocation received (without argv[0..1]). */
  argv(): Promise<string[] | null>;
  /** Replace the scenario for the next invocation. */
  setScenario(scenario: FakeToolScenario): Promise<void>;
  /** Remove the temporary directory. */
  cleanup(): Promise<void>;
}

const SCRIPT = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const self = process.argv[1];
const scenario = JSON.parse(fs.readFileSync(self + ".scenario.json", "utf8"));
const argv = process.argv.slice(2);
fs.writeFileSync(self + ".argv.json", JSON.stringify(argv));
if (scenario.version !== undefined && (argv.includes("--version") || argv.includes("version"))) {
  process.stdout.write(scenario.version + "\\n");
  process.exit(0);
}
const reportIndex = argv.indexOf("--report-path");
if (scenario.report !== undefined && reportIndex !== -1 && argv[reportIndex + 1]) {
  fs.writeFileSync(argv[reportIndex + 1], scenario.report);
}
if (scenario.stderr) process.stderr.write(scenario.stderr);
if (scenario.stdoutBytes) {
  process.stdout.write(Buffer.alloc(scenario.stdoutBytes, 120));
} else if (scenario.stdout) {
  process.stdout.write(scenario.stdout);
}
const finish = () => process.exit(scenario.exitCode ?? 0);
if (scenario.sleepMs) setTimeout(finish, scenario.sleepMs); else finish();
`;

/**
 * Create a fake executable in a fresh temporary directory. The name is kept
 * short and free of spaces so the shebang line works on every Linux kernel.
 */
export async function createFakeTool(
  name: string,
  scenario: FakeToolScenario = {},
): Promise<FakeTool> {
  const dir = await mkdtemp(join(tmpdir(), "guardia-fake-"));
  const path = join(dir, name);
  await writeFile(path, SCRIPT, "utf8");
  await chmod(path, 0o755);
  await writeFile(`${path}.scenario.json`, JSON.stringify(scenario), "utf8");
  return {
    path,
    async argv() {
      try {
        return JSON.parse(await readFile(`${path}.argv.json`, "utf8")) as string[];
      } catch {
        return null;
      }
    },
    async setScenario(next) {
      await writeFile(`${path}.scenario.json`, JSON.stringify(next), "utf8");
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
