import type {
  AnalysisResult,
  IsolationStatus,
  ScanAll,
  ScannerName,
  ScannerResult,
  Snapshot,
} from "../contracts.js";

export const REQUIRED_SCANNERS: readonly ScannerName[] = ["osv", "gitleaks"];

export interface OrchestrateOptions {
  snapshot: Snapshot;
  scanAll: ScanAll;
  strictOffline: boolean;
  isolation: IsolationStatus;
}

function scannerFailure(scanner: ScannerName, error?: string): ScannerResult {
  return {
    scanner,
    status: "error",
    version: null,
    filesAnalyzed: [],
    omitted: ["scanner did not return a result"],
    findings: [],
    ...(error ? { error } : {}),
  };
}

/** Enforces the adapter contract even when an injected adapter is faulty. */
function normalizeResults(results: ScannerResult[]): ScannerResult[] {
  const byName = new Map<ScannerName, ScannerResult>();
  for (const result of results) {
    if (!REQUIRED_SCANNERS.includes(result.scanner)) continue;
    if (!byName.has(result.scanner)) byName.set(result.scanner, result);
  }
  return REQUIRED_SCANNERS.map((name) => byName.get(name) ?? scannerFailure(name));
}

/**
 * Runs all required adapters and applies Guardia's deliberately conservative
 * state ordering: any missing coverage wins over findings.
 */
export async function orchestrate(options: OrchestrateOptions): Promise<AnalysisResult> {
  let scannerResults: ScannerResult[];
  try {
    scannerResults = normalizeResults(
      await options.scanAll({
        snapshotDir: options.snapshot.snapshotDir,
        lockfiles: options.snapshot.lockfiles,
      }),
    );
  } catch {
    scannerResults = REQUIRED_SCANNERS.map((scanner) =>
      scannerFailure(scanner, "The scanner coordinator failed before returning results."),
    );
  }

  const findings = scannerResults.flatMap((result) => result.findings);
  const incomplete =
    !options.snapshot.complete ||
    (options.strictOffline && options.isolation !== "verified") ||
    scannerResults.some((result) => result.status !== "ok");

  if (incomplete) {
    return {
      status: "INCOMPLETE",
      exitCode: 2,
      snapshot: options.snapshot,
      isolation: options.isolation,
      strictOffline: options.strictOffline,
      scanners: scannerResults,
      findings,
    };
  }
  if (findings.length > 0) {
    return {
      status: "FINDINGS",
      exitCode: 1,
      snapshot: options.snapshot,
      isolation: options.isolation,
      strictOffline: options.strictOffline,
      scanners: scannerResults,
      findings,
    };
  }
  return {
    status: "PASS",
    exitCode: 0,
    snapshot: options.snapshot,
    isolation: options.isolation,
    strictOffline: options.strictOffline,
    scanners: scannerResults,
    findings,
  };
}

export function snapshotFailure(
  message: string,
  strictOffline: boolean,
  isolation: IsolationStatus,
): AnalysisResult {
  return {
    status: "INCOMPLETE",
    exitCode: 2,
    snapshot: null,
    snapshotError: message,
    isolation,
    strictOffline,
    scanners: REQUIRED_SCANNERS.map((scanner) => ({
      scanner,
      status: "unsupported",
      version: null,
      filesAnalyzed: [],
      omitted: ["No safe snapshot was available."],
      findings: [],
    })),
    findings: [],
  };
}
