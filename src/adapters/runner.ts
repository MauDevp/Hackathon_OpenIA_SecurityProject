import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { ScannerName } from "./contracts.ts";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  TOOLS,
  isScannerName,
} from "./tools.ts";

/**
 * Outcome of running one pinned tool. Failure variants carry no tool output:
 * stdout and stderr may contain secrets or hostile content, so they are only
 * exposed on `completed`, and adapters must never copy them into results.
 */
export type RunOutcome =
  | {
      kind: "completed";
      exitCode: number;
      stdout: string;
      stderr: string;
      /** Names of the environment variables the child received. */
      envKeys: string[];
    }
  | { kind: "missing" }
  | { kind: "interrupted" }
  | { kind: "output-too-large" }
  | { kind: "rejected"; reason: RejectReason }
  | { kind: "spawn-failed"; code: string };

export type RejectReason =
  | "unknown-tool"
  | "invalid-arguments"
  | "env-override-not-absolute";

export interface RunOptions {
  /** Source environment. Defaults to `process.env`. Only allowlisted keys pass. */
  env?: NodeJS.ProcessEnv;
  /** Extra variable names to forward, for example the OSV database location. */
  extraEnv?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
}

const BASE_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

export interface ResolvedBinary {
  file: string;
  source: "env" | "path";
}

/**
 * Decide which executable to run. An env override must be absolute so that a
 * relative path can never resolve inside the analyzed repository.
 */
export function resolveBinary(
  tool: ScannerName,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBinary | { error: "env-override-not-absolute" } {
  const spec = TOOLS[tool];
  const override = env[spec.envBin];
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) return { error: "env-override-not-absolute" };
    return { file: override, source: "env" };
  }
  return { file: spec.binary, source: "path" };
}

function buildEnv(source: NodeJS.ProcessEnv, extra: readonly string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of [...BASE_ENV_ALLOWLIST, ...extra]) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function validArgs(args: unknown): args is string[] {
  return Array.isArray(args) && args.every((a) => typeof a === "string" && !a.includes("\u0000"));
}

interface ExecError extends NodeJS.ErrnoException {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}

/**
 * Run a tool from the closed list with an argv vector, never through a shell.
 * Timeout and output size are bounded; the environment is reduced to an
 * allowlist; stdin is not connected.
 */
export function runTool(
  tool: ScannerName,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunOutcome> {
  if (typeof tool !== "string" || !isScannerName(tool)) {
    return Promise.resolve({ kind: "rejected", reason: "unknown-tool" });
  }
  if (!validArgs(args)) {
    return Promise.resolve({ kind: "rejected", reason: "invalid-arguments" });
  }
  const sourceEnv = options.env ?? process.env;
  const resolved = resolveBinary(tool, sourceEnv);
  if ("error" in resolved) {
    return Promise.resolve({ kind: "rejected", reason: resolved.error });
  }
  const env = buildEnv(sourceEnv, options.extraEnv ?? []);
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    const execOptions: Parameters<typeof execFile>[2] = {
      env,
      timeout,
      maxBuffer,
      killSignal: "SIGKILL",
      windowsHide: true,
      shell: false,
      encoding: "utf8",
    };
    if (options.cwd !== undefined) execOptions.cwd = options.cwd;

    const child = execFile(resolved.file, [...args], execOptions, (error, stdout, stderr) => {
      if (!error) {
        resolve({ kind: "completed", exitCode: 0, stdout: String(stdout), stderr: String(stderr), envKeys: Object.keys(env) });
        return;
      }
      const err = error as ExecError;
      if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        resolve({ kind: "output-too-large" });
        return;
      }
      if (err.code === "ENOENT") {
        resolve({ kind: "missing" });
        return;
      }
      if (err.killed === true || (err.signal !== undefined && err.signal !== null)) {
        resolve({ kind: "interrupted" });
        return;
      }
      if (typeof err.code === "number") {
        resolve({ kind: "completed", exitCode: err.code, stdout: String(stdout), stderr: String(stderr), envKeys: Object.keys(env) });
        return;
      }
      resolve({ kind: "spawn-failed", code: typeof err.code === "string" ? err.code : "UNKNOWN" });
    });
    // The tools never need input; closing stdin avoids a child waiting on it.
    child.stdin?.end();
  });
}

/**
 * Ask a tool for its version. Returns the first stdout line, or null when the
 * tool is absent or misbehaves. Never throws.
 */
export async function readVersion(tool: ScannerName, options: RunOptions = {}): Promise<string | null> {
  const outcome = await runTool(tool, TOOLS[tool].versionArgs, { ...options, timeoutMs: 15_000 });
  if (outcome.kind !== "completed" || outcome.exitCode !== 0) return null;
  const firstLine = outcome.stdout.split(/\r?\n/, 1)[0] ?? "";
  const match = /(\d+\.\d+\.\d+)/.exec(firstLine);
  return match?.[1] ?? null;
}
