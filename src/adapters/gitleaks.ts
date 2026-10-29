import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Finding, ScanInput, ScannerResult } from "./contracts.ts";
import { checkSnapshot, relativeInside, walkSnapshot } from "./paths.ts";
import type { RunOptions } from "./runner.ts";
import { runTool } from "./runner.ts";
import { describeFailure, emptyResult, notFoundMessage, probeTool, truncate, versionNote } from "./shared.ts";
import { GITLEAKS_CONFIG_PATH } from "./tools.ts";

export interface GitleaksOptions {
  /** Source environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Team configuration passed with `--config`. Defaults to rules/gitleaks/guardia.toml in this package. */
  configPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** `src/adapters` and `dist/adapters` are both two levels below the package root. */
const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");
export const DEFAULT_GITLEAKS_CONFIG = resolve(PACKAGE_ROOT, GITLEAKS_CONFIG_PATH);

const TARGET_CONFIG_NAME = ".gitleaks.toml";
const TARGET_IGNORE_NAME = ".gitleaksignore";

export async function scanGitleaks(input: ScanInput, options: GitleaksOptions = {}): Promise<ScannerResult> {
  const result = emptyResult("gitleaks");
  const runOptions: RunOptions = { env: options.env ?? process.env };
  if (options.timeoutMs !== undefined) runOptions.timeoutMs = options.timeoutMs;
  if (options.maxOutputBytes !== undefined) runOptions.maxOutputBytes = options.maxOutputBytes;
  const configPath = options.configPath ?? DEFAULT_GITLEAKS_CONFIG;

  const check = await checkSnapshot(input.snapshotDir);
  if (!check.ok) {
    result.status = "error";
    result.error = "snapshotDir must be an absolute path to an existing directory";
    return result;
  }
  const snapshot = check.snapshot;

  const listing = await walkSnapshot(snapshot);
  for (const link of listing.symlinks) result.omitted.push(`${link}: symlink not followed`);
  // Gitleaks 8.30.1 always loads <target>/.gitleaksignore in addition to the
  // path given with --gitleaks-ignore-path, so a root ignore file cannot be
  // neutralized from the command line. The scan still runs and its findings
  // are kept, but coverage is then controlled by the repository: status error.
  const rootIgnoreFile = listing.files.includes(TARGET_IGNORE_NAME);
  for (const file of listing.files) {
    if (basename(file) === TARGET_CONFIG_NAME) result.omitted.push(`${file}: repository Gitleaks configuration ignored, team configuration used instead`);
    else if (file === TARGET_IGNORE_NAME) result.omitted.push(`${file}: repository .gitleaksignore is honored by Gitleaks and cannot be disabled; coverage not trusted`);
    else if (basename(file) === TARGET_IGNORE_NAME) result.omitted.push(`${file}: nested .gitleaksignore (not loaded by Gitleaks, listed for transparency)`);
  }

  const probe = await probeTool("gitleaks", runOptions);
  if (probe.kind === "missing") {
    result.status = "missing";
    result.error = notFoundMessage("gitleaks");
    result.omitted.push("snapshot not analyzed: scanner missing");
    return result;
  }
  if (probe.kind === "rejected") {
    result.status = "error";
    result.error = `gitleaks could not be started: ${probe.reason}`;
    return result;
  }
  result.version = probe.version;
  const note = versionNote("gitleaks", probe.version);
  if (note) result.omitted.push(note);

  // The report is written in a private temporary directory, never inside the
  // snapshot. The same directory holds an empty .gitleaksignore so that the
  // current directory's ignore file (the flag's default) is never honored.
  const reportDir = await mkdtemp(join(tmpdir(), "guardia-gitleaks-"));
  const reportPath = join(reportDir, "report.json");
  const emptyIgnorePath = join(reportDir, TARGET_IGNORE_NAME);
  try {
    await writeFile(emptyIgnorePath, "", "utf8");
    const outcome = await runTool(
      "gitleaks",
      [
        "dir", snapshot.root,
        "--config", configPath,
        "--report-format", "json",
        "--report-path", reportPath,
        "--redact",
        "--no-banner",
        "--no-color",
        "--exit-code", "0",
        // Repository-controlled suppressions are not trusted (observed on 8.30.1).
        "--ignore-gitleaks-allow",
        "--gitleaks-ignore-path", emptyIgnorePath,
      ],
      runOptions,
    );
    if (outcome.kind === "missing") {
      result.status = "missing";
      result.error = notFoundMessage("gitleaks");
      return result;
    }
    if (outcome.kind !== "completed") {
      result.status = "error";
      result.error = `gitleaks ${describeFailure(outcome)}`;
      return result;
    }
    if (outcome.exitCode !== 0) {
      // With --exit-code 0, a non-zero code can only be an execution failure.
      result.status = "error";
      result.error = `gitleaks exited with code ${outcome.exitCode}`;
      return result;
    }

    let raw: string;
    try {
      raw = await readFile(reportPath, "utf8");
    } catch {
      result.status = "error";
      result.error = "gitleaks did not produce a report file";
      return result;
    }
    const parsed = parseReport(raw);
    if (parsed === null) {
      result.status = "error";
      result.error = "gitleaks report is not valid JSON";
      return result;
    }
    for (const entry of parsed) {
      const rel = relativeInside(snapshot, entry.file);
      if (rel === null) {
        result.omitted.push(`finding for a path outside the snapshot dropped (rule ${entry.ruleId})`);
        continue;
      }
      const finding: Finding = {
        scanner: "gitleaks",
        type: "secret",
        id: entry.ruleId,
        path: rel,
        summary: truncate(entry.description ?? entry.ruleId),
      };
      if (entry.line !== undefined) finding.line = entry.line;
      result.findings.push(finding);
    }
    result.filesAnalyzed = listing.files;
    if (rootIgnoreFile) {
      result.status = "error";
      result.error = "snapshot contains a root .gitleaksignore that Gitleaks honors; remove it from the snapshot to trust this scan";
    }
    return result;
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}

interface ReportEntry {
  ruleId: string;
  file: string;
  line?: number;
  description?: string;
}

/**
 * Keep only the four safe fields of each Gitleaks report entry. `Match`,
 * `Secret`, `Line` and everything else are discarded here and never read again.
 */
export function parseReport(raw: string): ReportEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries: ReportEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return null;
    const record = item as Record<string, unknown>;
    if (typeof record["RuleID"] !== "string" || typeof record["File"] !== "string") return null;
    const entry: ReportEntry = { ruleId: record["RuleID"], file: record["File"] };
    if (typeof record["StartLine"] === "number" && record["StartLine"] > 0) entry.line = record["StartLine"];
    if (typeof record["Description"] === "string" && record["Description"] !== "") entry.description = record["Description"];
    entries.push(entry);
  }
  return entries;
}
