import type { ScannerName, ScannerResult } from "./contracts.ts";
import type { RunOptions, RunOutcome } from "./runner.ts";
import { parseVersion, runTool } from "./runner.ts";
import { TOOLS } from "./tools.ts";

export const SUMMARY_MAX = 200;

export function truncate(text: string, max: number = SUMMARY_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function emptyResult(scanner: ScannerName): ScannerResult {
  return { scanner, status: "ok", version: null, filesAnalyzed: [], omitted: [], findings: [] };
}

export type Probe =
  | { kind: "missing" }
  | { kind: "rejected"; reason: string }
  | { kind: "present"; version: string | null };

/** Find out whether the tool exists and which version answers. */
export async function probeTool(tool: ScannerName, options: RunOptions): Promise<Probe> {
  const outcome = await runTool(tool, TOOLS[tool].versionArgs, { ...options, timeoutMs: 15_000 });
  if (outcome.kind === "missing") return { kind: "missing" };
  if (outcome.kind === "rejected") return { kind: "rejected", reason: outcome.reason };
  if (outcome.kind === "completed" && outcome.exitCode === 0) return { kind: "present", version: parseVersion(outcome.stdout) };
  return { kind: "present", version: null };
}

export function versionNote(tool: ScannerName, version: string | null): string | null {
  const pinned = TOOLS[tool].pinnedVersion;
  if (version === null) return `${TOOLS[tool].binary}: version could not be read; adapters were validated against ${pinned}`;
  if (version !== pinned) return `${TOOLS[tool].binary}: version ${version} differs from pinned ${pinned}; adapters were validated against ${pinned}`;
  return null;
}

/** Fixed, output-free description of a failed run. */
export function describeFailure(outcome: Exclude<RunOutcome, { kind: "completed" }>): string {
  switch (outcome.kind) {
    case "missing": return "executable not found";
    case "interrupted": return "interrupted (timeout or signal)";
    case "output-too-large": return "output exceeded the size limit";
    case "rejected": return `rejected before execution (${outcome.reason})`;
    case "spawn-failed": return `could not start process (${outcome.code})`;
  }
}

export function notFoundMessage(tool: ScannerName): string {
  const spec = TOOLS[tool];
  return `${spec.binary} executable not found: set ${spec.envBin} to an absolute path or add it to PATH`;
}
