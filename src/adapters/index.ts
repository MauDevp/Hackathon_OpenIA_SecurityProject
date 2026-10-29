import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type { Finding, ScanAll, ScanInput, ScannerName, ScannerResult } from "../contracts.js";

const execFile = promisify(execFileCallback);
const TOOL_TIMEOUT_MS = 120_000;
const MAX_TOOL_OUTPUT_BYTES = 16 * 1024 * 1024;
const OSV_DATABASE_ENV = "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY";

const OSV_LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "requirements.txt",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "pdm.lock",
]);

interface CompletedCommand {
  kind: "completed";
  stdout: string;
  stderr: string;
  exitCode: number;
}

type CommandOutcome = CompletedCommand | { kind: "missing" } | { kind: "failed" };

function toolEnvironment(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/** Runs only a fixed scanner command with an argv array, never a shell. */
async function runTool(binary: string, args: string[], extraEnvironment: Record<string, string | undefined> = {}): Promise<CommandOutcome> {
  try {
    const result = await execFile(binary, args, {
      env: toolEnvironment(extraEnvironment),
      encoding: "utf8",
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
    });
    return { kind: "completed", stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
      killed?: boolean;
    };
    if (commandError.code === "ENOENT") return { kind: "missing" };
    // A non-zero exit still has useful JSON output for OSV-Scanner.
    if (typeof commandError.code === "number" && !commandError.killed) {
      return {
        kind: "completed",
        stdout: commandError.stdout ?? "",
        stderr: commandError.stderr ?? "",
        exitCode: commandError.code,
      };
    }
    // Never return raw scanner output: it may contain a secret match.
    return { kind: "failed" };
  }
}

async function toolVersion(scanner: ScannerName): Promise<{ state: "available" | "missing" | "error"; version: string | null }> {
  const outcome = await runTool(scanner === "osv" ? "osv-scanner" : "gitleaks", scanner === "osv" ? ["--version"] : ["version"]);
  if (outcome.kind === "missing") return { state: "missing", version: null };
  if (outcome.kind !== "completed" || outcome.exitCode !== 0) return { state: "error", version: null };
  const version = /(\d+\.\d+(?:\.\d+)?)/.exec(`${outcome.stdout}\n${outcome.stderr}`)?.[1] ?? null;
  return { state: "available", version };
}

function result(
  scanner: ScannerName,
  status: ScannerResult["status"],
  version: string | null,
  additions: Partial<Omit<ScannerResult, "scanner" | "status" | "version">> = {},
): ScannerResult {
  return {
    scanner,
    status,
    version,
    filesAnalyzed: [],
    omitted: [],
    findings: [],
    ...additions,
  };
}

function safeRelativePath(snapshotDir: string, candidate: unknown): string | null {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(snapshotDir, candidate);
  const between = relative(snapshotDir, absolute);
  if (between === "" || between === ".." || between.startsWith(`..${sep}`) || isAbsolute(between)) return null;
  return between.split(sep).join("/");
}

function parseOsvFindings(raw: string, lockfile: string): Finding[] | null {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!document || typeof document !== "object" || !Array.isArray((document as { results?: unknown }).results)) return null;
  const findings: Finding[] = [];
  for (const entry of (document as { results: unknown[] }).results) {
    if (!entry || typeof entry !== "object" || !Array.isArray((entry as { packages?: unknown }).packages)) return null;
    for (const packageEntry of (entry as { packages: unknown[] }).packages) {
      if (!packageEntry || typeof packageEntry !== "object") return null;
      const packageData = (packageEntry as { package?: unknown }).package;
      const name = packageData && typeof packageData === "object" && typeof (packageData as { name?: unknown }).name === "string"
        ? (packageData as { name: string }).name
        : "dependency";
      const version = packageData && typeof packageData === "object" && typeof (packageData as { version?: unknown }).version === "string"
        ? (packageData as { version: string }).version
        : "unknown";
      const groups = (packageEntry as { groups?: unknown }).groups;
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const ids = group && typeof group === "object" ? (group as { ids?: unknown }).ids : undefined;
        if (!Array.isArray(ids)) continue;
        for (const id of ids) {
          if (typeof id !== "string" || id.length === 0) continue;
          findings.push({
            scanner: "osv",
            type: "dependency",
            id,
            path: lockfile,
            summary: `${name}@${version} is affected by ${id}`,
          });
        }
      }
    }
  }
  return findings;
}

async function databaseMetadata(): Promise<NonNullable<ScannerResult["database"]>> {
  const directory = process.env[OSV_DATABASE_ENV] ?? resolve(process.cwd(), ".guardia", "osv-db");
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, "guardia-db-meta.json"), "utf8"));
    if (parsed && typeof parsed === "object") {
      const source = parsed as { downloadedAt?: unknown; sourceDate?: unknown; sha256?: unknown };
      return {
        downloadedAt: typeof source.downloadedAt === "string" ? source.downloadedAt : null,
        sourceDate: typeof source.sourceDate === "string" ? source.sourceDate : null,
        sha256: typeof source.sha256 === "string" ? source.sha256 : null,
      };
    }
  } catch {
    // A missing sidecar means the database dates and hash are unknown.
  }
  return { downloadedAt: null, sourceDate: null, sha256: null };
}

function looksLikeMissingDatabase(stderr: string): boolean {
  return /no offline version of the OSV database is available/i.test(stderr);
}

async function scanOsv(input: ScanInput): Promise<ScannerResult> {
  const database = await databaseMetadata();
  const version = await toolVersion("osv");
  if (version.state === "missing") {
    return result("osv", "missing", null, {
      omitted: input.lockfiles.length > 0
        ? input.lockfiles.map((path) => `${path}: OSV-Scanner is not installed`)
        : ["No supported lockfile was present and OSV-Scanner is not installed."],
      database,
    });
  }
  if (version.state === "error") {
    return result("osv", "error", null, {
      omitted: input.lockfiles.map((path) => `${path}: OSV-Scanner could not be started`),
      findings: [],
      error: "OSV-Scanner could not report a usable version.",
      database,
    });
  }
  if (input.lockfiles.length === 0) {
    return result("osv", "unsupported", version.version, {
      omitted: ["No supported lockfile was detected in the snapshot."],
      database,
    });
  }

  const filesAnalyzed: string[] = [];
  const omitted: string[] = [];
  const findings: Finding[] = [];
  let hasError = false;
  let missingDatabase = false;
  const databaseDirectory = process.env[OSV_DATABASE_ENV] ?? resolve(process.cwd(), ".guardia", "osv-db");

  for (const lockfile of input.lockfiles) {
    const relativeLockfile = safeRelativePath(input.snapshotDir, lockfile);
    if (relativeLockfile === null || !OSV_LOCKFILES.has(basename(relativeLockfile))) {
      hasError = true;
      omitted.push(`${lockfile}: unsupported or unsafe lockfile path`);
      continue;
    }
    const absoluteLockfile = resolve(input.snapshotDir, relativeLockfile);
    const outcome = await runTool(
      "osv-scanner",
      ["scan", "--offline", "--format", "json", "-L", absoluteLockfile],
      { [OSV_DATABASE_ENV]: databaseDirectory },
    );
    if (outcome.kind === "missing") {
      return result("osv", "missing", version.version, {
        filesAnalyzed,
        omitted: [...omitted, `${relativeLockfile}: OSV-Scanner became unavailable`],
        findings,
        error: "OSV-Scanner was not available for every lockfile.",
        database,
      });
    }
    if (outcome.kind !== "completed") {
      hasError = true;
      omitted.push(`${relativeLockfile}: OSV-Scanner did not complete`);
      continue;
    }
    if (outcome.exitCode === 0 || outcome.exitCode === 1) {
      const parsed = parseOsvFindings(outcome.stdout, relativeLockfile);
      if (parsed === null) {
        hasError = true;
        omitted.push(`${relativeLockfile}: OSV-Scanner did not return valid JSON`);
      } else {
        filesAnalyzed.push(relativeLockfile);
        findings.push(...parsed);
      }
    } else if (looksLikeMissingDatabase(outcome.stderr)) {
      missingDatabase = true;
      omitted.push(`${relativeLockfile}: local OSV database was not available`);
    } else {
      hasError = true;
      omitted.push(`${relativeLockfile}: OSV-Scanner did not complete`);
    }
  }

  if (missingDatabase) {
    return result("osv", "missing", version.version, {
      filesAnalyzed,
      omitted,
      findings,
      error: "The required local OSV advisory database is not available.",
      database,
    });
  }
  return result("osv", hasError ? "error" : "ok", version.version, {
    filesAnalyzed,
    omitted,
    findings,
    ...(hasError ? { error: "OSV-Scanner did not complete every requested lockfile." } : {}),
    database,
  });
}

function parseGitleaksFindings(raw: string, snapshotDir: string): Finding[] | null {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(document)) return null;
  const findings: Finding[] = [];
  for (const entry of document) {
    if (!entry || typeof entry !== "object") return null;
    const leak = entry as { RuleID?: unknown; Description?: unknown; File?: unknown; StartLine?: unknown };
    if (typeof leak.RuleID !== "string" || typeof leak.File !== "string") return null;
    const path = safeRelativePath(snapshotDir, leak.File);
    if (path === null) continue;
    const line = typeof leak.StartLine === "number" && Number.isSafeInteger(leak.StartLine) && leak.StartLine > 0
      ? leak.StartLine
      : undefined;
    findings.push({
      scanner: "gitleaks",
      type: "secret",
      id: leak.RuleID,
      path,
      ...(line === undefined ? {} : { line }),
      // Deliberately ignore Match, Secret, Line, Author and other unsafe fields.
      summary: typeof leak.Description === "string" && leak.Description.length > 0 ? leak.Description : leak.RuleID,
    });
  }
  return findings;
}

async function snapshotIsDirectory(snapshotDir: string): Promise<boolean> {
  if (!isAbsolute(snapshotDir)) return false;
  try {
    return (await stat(snapshotDir)).isDirectory();
  } catch {
    return false;
  }
}

async function snapshotHasRootIgnore(snapshotDir: string): Promise<boolean> {
  try {
    return (await stat(join(snapshotDir, ".gitleaksignore"))).isFile();
  } catch {
    return false;
  }
}

/** Config path works both from src/ and from compiled dist/. */
const TEAM_GITLEAKS_CONFIG = fileURLToPath(new URL("../../rules/gitleaks/guardia.toml", import.meta.url));

async function scanGitleaks(input: ScanInput): Promise<ScannerResult> {
  if (!(await snapshotIsDirectory(input.snapshotDir))) {
    return result("gitleaks", "error", null, {
      omitted: ["Snapshot directory is not a readable absolute directory."],
      error: "Gitleaks was not run because the snapshot is invalid.",
    });
  }
  const hasRootIgnore = await snapshotHasRootIgnore(input.snapshotDir);
  const version = await toolVersion("gitleaks");
  if (version.state === "missing") {
    return result("gitleaks", "missing", null, {
      omitted: ["Snapshot was not analyzed because Gitleaks is not installed."],
    });
  }
  if (version.state === "error") {
    return result("gitleaks", "error", null, {
      omitted: ["Snapshot was not analyzed because Gitleaks could not start."],
      error: "Gitleaks could not report a usable version.",
    });
  }

  const reportDirectory = await mkdtemp(join(tmpdir(), "guardia-gitleaks-"));
  const reportPath = join(reportDirectory, "report.json");
  try {
    const outcome = await runTool("gitleaks", [
      "dir",
      input.snapshotDir,
      "--config",
      TEAM_GITLEAKS_CONFIG,
      "--report-format",
      "json",
      "--report-path",
      reportPath,
      "--redact",
      "--no-banner",
      "--no-color",
      "--exit-code",
      "0",
      "--ignore-gitleaks-allow",
    ]);
    if (outcome.kind === "missing") {
      return result("gitleaks", "missing", version.version, {
        omitted: ["Snapshot was not analyzed because Gitleaks became unavailable."],
      });
    }
    if (outcome.kind !== "completed" || outcome.exitCode !== 0) {
      return result("gitleaks", "error", version.version, {
        omitted: ["Snapshot: Gitleaks did not complete."],
        error: "Gitleaks did not complete successfully.",
      });
    }
    let report: string;
    try {
      report = await readFile(reportPath, "utf8");
    } catch {
      return result("gitleaks", "error", version.version, {
        omitted: ["Snapshot: Gitleaks did not create a JSON report."],
        error: "Gitleaks completed without a readable report.",
      });
    }
    const findings = parseGitleaksFindings(report, input.snapshotDir);
    if (findings === null) {
      return result("gitleaks", "error", version.version, {
        omitted: ["Snapshot: Gitleaks returned an unsupported report format."],
        error: "Gitleaks JSON report could not be parsed.",
      });
    }
    if (hasRootIgnore) {
      return result("gitleaks", "error", version.version, {
        filesAnalyzed: [],
        omitted: [
          "Snapshot has a root .gitleaksignore that can suppress findings.",
          "Gitleaks completed a directory scan but does not report per-file coverage.",
        ],
        findings,
        error: "Gitleaks coverage is not trusted while the snapshot includes .gitleaksignore.",
      });
    }
    return result("gitleaks", "ok", version.version, {
      // Gitleaks confirms the completed directory scan, but its JSON does not
      // disclose a per-file coverage list. Do not invent one here.
      filesAnalyzed: [],
      omitted: ["Gitleaks completed a directory scan but does not report per-file coverage."],
      findings,
    });
  } finally {
    await rm(reportDirectory, { recursive: true, force: true });
  }
}

function unexpectedAdapterFailure(scanner: ScannerName): ScannerResult {
  return result(scanner, "error", null, {
    omitted: ["Scanner did not return a usable result."],
    error: "The scanner adapter failed unexpectedly.",
  });
}

/** Both results are always present, including when tools are unavailable. */
export const scanAll: ScanAll = async (input) => {
  const outcomes = await Promise.allSettled([scanOsv(input), scanGitleaks(input)]);
  const osv = outcomes[0];
  const gitleaks = outcomes[1];
  return [
    osv?.status === "fulfilled" ? osv.value : unexpectedAdapterFailure("osv"),
    gitleaks?.status === "fulfilled" ? gitleaks.value : unexpectedAdapterFailure("gitleaks"),
  ];
};

export const internal = { parseGitleaksFindings, parseOsvFindings, safeRelativePath };
