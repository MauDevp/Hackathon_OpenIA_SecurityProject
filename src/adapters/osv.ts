import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Finding, ScanInput, ScannerResult } from "./contracts.ts";
import type { Snapshot } from "./paths.ts";
import { checkSnapshot, resolveInside } from "./paths.ts";
import type { RunOptions } from "./runner.ts";
import { runTool } from "./runner.ts";
import { describeFailure, emptyResult, notFoundMessage, probeTool, truncate, versionNote } from "./shared.ts";
import { DEFAULT_OSV_DB_DIR, OSV_DB_ENV, OSV_DB_META_FILE } from "./tools.ts";

export interface OsvOptions {
  /** Source environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Base for the default database directory; defaults to `process.cwd()`. */
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Lockfile basenames OSV-Scanner 2.7.0 extracts, mapped to their OSV ecosystem. */
const LOCKFILE_ECOSYSTEMS: Readonly<Record<string, string>> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "npm",
  "pnpm-lock.yaml": "npm",
  "bun.lock": "npm",
  "requirements.txt": "PyPI",
  "poetry.lock": "PyPI",
  "Pipfile.lock": "PyPI",
  "uv.lock": "PyPI",
  "pdm.lock": "PyPI",
};

/** Fixed stderr fragments observed on 2.7.0 (see docs/scanners.md, cases C and E). */
const STDERR_DB_MISSING = "no offline version of the OSV database is available";
const STDERR_NO_EXTRACTOR = "could not determine extractor";

type FileOutcome =
  | { kind: "analyzed"; findings: Finding[] }
  | { kind: "db-missing"; ecosystem: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "tool-missing" }
  | { kind: "failed"; detail: string };

interface DbInfo {
  sha256: string;
  downloadedAt: string | null;
}

export async function scanOsv(input: ScanInput, options: OsvOptions = {}): Promise<ScannerResult> {
  const result = emptyResult("osv");
  result.database = { downloadedAt: null, sourceDate: null, sha256: null };

  const sourceEnv = options.env ?? process.env;
  const dbDir = sourceEnv[OSV_DB_ENV] || resolve(options.cwd ?? process.cwd(), DEFAULT_OSV_DB_DIR);
  const runOptions: RunOptions = { env: { ...sourceEnv, [OSV_DB_ENV]: dbDir }, extraEnv: [OSV_DB_ENV] };
  if (options.timeoutMs !== undefined) runOptions.timeoutMs = options.timeoutMs;
  if (options.maxOutputBytes !== undefined) runOptions.maxOutputBytes = options.maxOutputBytes;

  const check = await checkSnapshot(input.snapshotDir);
  if (!check.ok) {
    result.status = "error";
    result.error = "snapshotDir must be an absolute path to an existing directory";
    result.omitted = input.lockfiles.map((l) => `${l}: snapshot not valid`);
    return result;
  }
  if (input.lockfiles.length === 0) {
    result.status = "unsupported";
    result.error = "no lockfiles were provided; dependency scan not applicable";
    return result;
  }

  const probe = await probeTool("osv", runOptions);
  if (probe.kind === "missing") {
    result.status = "missing";
    result.error = notFoundMessage("osv");
    result.omitted = input.lockfiles.map((l) => `${l}: not analyzed, scanner missing`);
    return result;
  }
  if (probe.kind === "rejected") {
    result.status = "error";
    result.error = `osv-scanner could not be started: ${probe.reason}`;
    result.omitted = input.lockfiles.map((l) => `${l}: not analyzed`);
    return result;
  }
  result.version = probe.version;
  const note = versionNote("osv", probe.version);
  if (note) result.omitted.push(note);

  const meta = await readMeta(dbDir);
  const dbInfo = new Map<string, DbInfo>();
  const failures: string[] = [];
  const missingEcosystems = new Set<string>();
  let toolMissing = false;

  for (const rel of input.lockfiles) {
    const outcome = await scanOne(check.snapshot, rel, dbDir, meta, dbInfo, runOptions);
    switch (outcome.kind) {
      case "analyzed":
        result.filesAnalyzed.push(rel);
        result.findings.push(...outcome.findings);
        break;
      case "db-missing":
        missingEcosystems.add(outcome.ecosystem);
        result.omitted.push(`${rel}: offline database for ${outcome.ecosystem} not found`);
        break;
      case "unsupported":
        result.omitted.push(outcome.reason);
        break;
      case "tool-missing":
        toolMissing = true;
        result.omitted.push(`${rel}: not analyzed, scanner missing`);
        break;
      case "failed":
        failures.push(`${rel}: ${outcome.detail}`);
        result.omitted.push(`${rel}: not analyzed (${outcome.detail})`);
        break;
    }
  }

  const ecosystems = [...dbInfo.keys()];
  const first = ecosystems[0];
  if (first !== undefined) {
    const info = dbInfo.get(first) as DbInfo;
    result.database = { downloadedAt: info.downloadedAt, sourceDate: null, sha256: info.sha256 };
    if (ecosystems.length > 1) result.omitted.push(`database metadata reported for ${first} only (also used: ${ecosystems.slice(1).join(", ")})`);
  }

  if (toolMissing) {
    result.status = "missing";
    result.error = notFoundMessage("osv");
  } else if (missingEcosystems.size > 0) {
    result.status = "missing";
    result.error = `OSV offline database not found for: ${[...missingEcosystems].join(", ")} (expected under ${OSV_DB_ENV})`;
  } else if (failures.length > 0) {
    result.status = "error";
    result.error = `${failures.length} lockfile(s) could not be analyzed: ${failures.join("; ")}`;
  } else if (result.filesAnalyzed.length === 0) {
    result.status = "unsupported";
    result.error = "no supported lockfiles were analyzed";
  }
  return result;
}

async function scanOne(
  snapshot: Snapshot,
  rel: string,
  dbDir: string,
  meta: Record<string, string | null>,
  dbInfo: Map<string, DbInfo>,
  runOptions: RunOptions,
): Promise<FileOutcome> {
  const inside = await resolveInside(snapshot, rel);
  if (!inside.ok) return { kind: "failed", detail: `path rejected (${inside.reason})` };

  const ecosystem = LOCKFILE_ECOSYSTEMS[basename(inside.relative)];
  if (ecosystem === undefined) return { kind: "unsupported", reason: `${rel}: unsupported lockfile type` };

  const dbFile = join(dbDir, "osv-scalibr", ecosystem, "all.zip");
  if (!(await exists(dbFile))) return { kind: "db-missing", ecosystem };
  if (!dbInfo.has(ecosystem)) {
    dbInfo.set(ecosystem, { sha256: await sha256File(dbFile), downloadedAt: meta[ecosystem] ?? null });
  }

  const outcome = await runTool("osv", ["scan", "--offline", "--format", "json", "-L", inside.absolute], runOptions);
  if (outcome.kind === "missing") return { kind: "tool-missing" };
  if (outcome.kind !== "completed") return { kind: "failed", detail: describeFailure(outcome) };

  switch (outcome.exitCode) {
    case 0:
    case 1: {
      const findings = parseFindings(outcome.stdout, inside.relative);
      if (findings === null) return { kind: "failed", detail: "invalid JSON output" };
      return { kind: "analyzed", findings };
    }
    case 128:
      return { kind: "unsupported", reason: `${rel}: no packages found in lockfile` };
    case 127:
      if (outcome.stderr.includes(STDERR_DB_MISSING)) return { kind: "db-missing", ecosystem };
      if (outcome.stderr.includes(STDERR_NO_EXTRACTOR)) return { kind: "unsupported", reason: `${rel}: file type not supported by osv-scanner` };
      return { kind: "failed", detail: "exit code 127" };
    default:
      return { kind: "failed", detail: `exit code ${outcome.exitCode}` };
  }
}

/**
 * Map OSV-Scanner JSON to findings. Every vulnerability of every package in
 * the single lockfile scanned becomes one finding. Returns null on invalid
 * shape so the caller can report an error instead of a clean result.
 */
export function parseFindings(stdout: string, lockfileRel: string): Finding[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["results"])) return null;
  const findings: Finding[] = [];
  for (const entry of parsed["results"]) {
    if (!isRecord(entry) || !Array.isArray(entry["packages"])) continue;
    for (const pkg of entry["packages"]) {
      if (!isRecord(pkg)) continue;
      const info = isRecord(pkg["package"]) ? pkg["package"] : {};
      const name = typeof info["name"] === "string" ? info["name"] : "unknown";
      const version = typeof info["version"] === "string" ? info["version"] : "unknown";
      const vulns = Array.isArray(pkg["vulnerabilities"]) ? pkg["vulnerabilities"] : [];
      for (const vuln of vulns) {
        if (!isRecord(vuln) || typeof vuln["id"] !== "string") continue;
        const summary = typeof vuln["summary"] === "string" && vuln["summary"] !== "" ? vuln["summary"] : vuln["id"];
        findings.push({
          scanner: "osv",
          type: "dependency",
          id: vuln["id"],
          path: lockfileRel,
          summary: truncate(`${name}@${version}: ${summary}`),
        });
      }
    }
  }
  return findings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** `{ [ecosystem]: downloadedAt }` from the sidecar written at download time. */
async function readMeta(dbDir: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  try {
    const raw: unknown = JSON.parse(await readFile(join(dbDir, OSV_DB_META_FILE), "utf8"));
    if (!isRecord(raw) || !isRecord(raw["databases"])) return out;
    for (const [eco, value] of Object.entries(raw["databases"])) {
      out[eco] = isRecord(value) && typeof value["downloadedAt"] === "string" ? value["downloadedAt"] : null;
    }
  } catch {
    // Sidecar absent or unreadable: downloadedAt stays null.
  }
  return out;
}
