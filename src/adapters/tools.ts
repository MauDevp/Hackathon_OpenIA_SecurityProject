import type { ScannerName } from "./contracts.ts";

/**
 * Pinned external tools. Versions were verified against the official
 * releases on 2026-10-28 (see docs/scanners.md for checksums and commands).
 */
export interface ToolSpec {
  /** Executable name looked up in PATH when the env override is absent. */
  readonly binary: string;
  /** Environment variable that overrides the executable path. */
  readonly envBin: string;
  /** Version the adapters were written and tested against. */
  readonly pinnedVersion: string;
  /** Arguments that make the tool print its version. */
  readonly versionArgs: readonly string[];
}

export const TOOLS: Readonly<Record<ScannerName, ToolSpec>> = {
  osv: {
    binary: "osv-scanner",
    envBin: "GUARDIA_OSV_SCANNER_BIN",
    pinnedVersion: "2.7.0",
    versionArgs: ["--version"],
  },
  gitleaks: {
    binary: "gitleaks",
    envBin: "GUARDIA_GITLEAKS_BIN",
    pinnedVersion: "8.30.1",
    versionArgs: ["version"],
  },
};

/** OSV-Scanner reads its offline database root from this variable. */
export const OSV_DB_ENV = "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY";

/** Default database root, relative to the current working directory. */
export const DEFAULT_OSV_DB_DIR = ".guardia/osv-db";

/** Sidecar written by the manual download step next to the database root. */
export const OSV_DB_META_FILE = "guardia-db-meta.json";

/** Team-owned Gitleaks configuration, always passed with `--config`. */
export const GITLEAKS_CONFIG_PATH = "rules/gitleaks/guardia.toml";

/** Opt-in switch for tests that need the real binaries and database. */
export const INTEGRATION_ENV = "GUARDIA_INTEGRATION";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export function isScannerName(value: string): value is ScannerName {
  return Object.prototype.hasOwnProperty.call(TOOLS, value);
}
