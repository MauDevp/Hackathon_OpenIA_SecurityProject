import type { AnalysisResult, Finding, ScannerResult } from "../contracts.js";

export const REPORT_FORMAT_VERSION = "1.0";

const REDACTION = "[REDACTED]";

/** Defense in depth: adapters avoid values; reporting also removes common leaks. */
export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTION)
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, REDACTION)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTION)
    .replace(/\bDEMO_[A-Za-z0-9_]{8,}\b/g, REDACTION)
    .replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTION}`);
}

function redactFinding(finding: Finding): Finding {
  return {
    ...finding,
    id: redactSecrets(finding.id),
    path: redactSecrets(finding.path),
    summary: redactSecrets(finding.summary),
  };
}

function redactScanner(result: ScannerResult): ScannerResult {
  const findings = result.findings.map(redactFinding);
  return {
    ...result,
    findings,
    ...(result.error ? { error: redactSecrets(result.error) } : {}),
  };
}

export interface GuardiaReport {
  formatVersion: string;
  status: AnalysisResult["status"];
  exitCode: AnalysisResult["exitCode"];
  executedAt: string;
  commit: string | null;
  isolation: { status: AnalysisResult["isolation"]; strictOffline: boolean };
  snapshot: {
    complete: boolean;
    excluded: string[];
    omitted: string[];
    error?: string;
  };
  lockfiles: string[];
  filesAnalyzed: string[];
  omitted: string[];
  scanners: ScannerResult[];
  findings: Finding[];
}

export function createReport(result: AnalysisResult, executedAt = new Date().toISOString()): GuardiaReport {
  const scanners = result.scanners.map(redactScanner);
  const snapshot = result.snapshot;
  const findings = result.findings.map(redactFinding);
  const filesAnalyzed = [...new Set(scanners.flatMap((scanner) => scanner.filesAnalyzed))].sort();
  const omitted = [
    ...(snapshot?.omitted ?? []),
    ...scanners.flatMap((scanner) => scanner.omitted.map((item) => `${scanner.scanner}: ${item}`)),
  ].map(redactSecrets);

  return {
    formatVersion: REPORT_FORMAT_VERSION,
    status: result.status,
    exitCode: result.exitCode,
    executedAt,
    commit: snapshot?.commit ?? null,
    isolation: { status: result.isolation, strictOffline: result.strictOffline },
    snapshot: {
      complete: snapshot?.complete ?? false,
      excluded: (snapshot?.excluded ?? []).map(redactSecrets),
      omitted: (snapshot?.omitted ?? []).map(redactSecrets),
      ...(result.snapshotError ? { error: redactSecrets(result.snapshotError) } : {}),
    },
    lockfiles: snapshot?.lockfiles ?? [],
    filesAnalyzed,
    omitted,
    scanners,
    findings,
  };
}

export function serializeReport(result: AnalysisResult, executedAt?: string): string {
  return `${JSON.stringify(createReport(result, executedAt), null, 2)}\n`;
}

export function terminalSummary(result: AnalysisResult, reportPath: string): string {
  const lines = [
    `guardia: ${result.status} (exit ${result.exitCode})`,
    `commit: ${result.snapshot?.commit ?? "unavailable"}`,
    `isolation: ${result.isolation}${result.strictOffline ? " (strict requested)" : ""}`,
    `findings: ${result.findings.length}`,
  ];
  for (const scanner of result.scanners) {
    lines.push(`${scanner.scanner}: ${scanner.status}${scanner.version ? ` (${scanner.version})` : ""}`);
  }
  lines.push(`report: ${reportPath}`);
  return `${lines.map(redactSecrets).join("\n")}\n`;
}
