import type { ScanAll, ScanInput, ScannerName, ScannerResult } from "./contracts.ts";
import type { GitleaksOptions } from "./gitleaks.ts";
import { scanGitleaks } from "./gitleaks.ts";
import type { OsvOptions } from "./osv.ts";
import { scanOsv } from "./osv.ts";

export type { Finding, ScanAll, ScanInput, ScannerName, ScannerResult } from "./contracts.ts";
export { scanGitleaks } from "./gitleaks.ts";
export { scanOsv } from "./osv.ts";
export { TOOLS, OSV_DB_ENV, DEFAULT_OSV_DB_DIR } from "./tools.ts";

export type Adapter = (input: ScanInput) => Promise<ScannerResult>;

export interface ScanAllOptions {
  /** Source environment for both tools; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Base for the default OSV database directory; defaults to `process.cwd()`. */
  cwd?: string;
  timeoutMs?: number;
  /** Replace individual adapters (tests and future scanners). */
  adapters?: Partial<Record<ScannerName, Adapter>>;
}

/** Order of the results returned by scanAll. */
export const SCANNER_ORDER: readonly ScannerName[] = ["osv", "gitleaks"];

const STATUSES: ReadonlySet<string> = new Set(["ok", "missing", "error", "unsupported"]);

/**
 * Build a `scanAll` that runs every scanner concurrently and always returns
 * exactly one result per scanner, in SCANNER_ORDER. An adapter that throws or
 * returns garbage becomes `status: "error"` with a fixed message, so a crash
 * can never be mistaken for a clean scan and never leaks exception text.
 */
export function createScanAll(options: ScanAllOptions = {}): ScanAll {
  const osvOptions: OsvOptions = {};
  const gitleaksOptions: GitleaksOptions = {};
  if (options.env !== undefined) {
    osvOptions.env = options.env;
    gitleaksOptions.env = options.env;
  }
  if (options.cwd !== undefined) osvOptions.cwd = options.cwd;
  if (options.timeoutMs !== undefined) {
    osvOptions.timeoutMs = options.timeoutMs;
    gitleaksOptions.timeoutMs = options.timeoutMs;
  }
  const adapters: Record<ScannerName, Adapter> = {
    osv: options.adapters?.osv ?? ((input) => scanOsv(input, osvOptions)),
    gitleaks: options.adapters?.gitleaks ?? ((input) => scanGitleaks(input, gitleaksOptions)),
  };

  return async (input: ScanInput): Promise<ScannerResult[]> => {
    const settled = await Promise.allSettled(SCANNER_ORDER.map((name) => adapters[name](input)));
    return SCANNER_ORDER.map((name, index) => {
      const outcome = settled[index];
      if (outcome?.status === "fulfilled" && isResultFor(name, outcome.value)) return outcome.value;
      return failure(name, outcome?.status === "rejected" ? "adapter failed unexpectedly" : "adapter returned an invalid result");
    });
  };
}

/** Default instance: real adapters, `process.env`, `process.cwd()`. */
export const scanAll: ScanAll = createScanAll();

function isResultFor(name: ScannerName, value: unknown): value is ScannerResult {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return r["scanner"] === name
    && typeof r["status"] === "string" && STATUSES.has(r["status"])
    && Array.isArray(r["filesAnalyzed"]) && Array.isArray(r["omitted"]) && Array.isArray(r["findings"]);
}

function failure(scanner: ScannerName, error: string): ScannerResult {
  return { scanner, status: "error", version: null, filesAnalyzed: [], omitted: ["nothing analyzed"], findings: [], error };
}
