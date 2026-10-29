/** Names of scanners required by the first Guardia profile. */
export type ScannerName = "osv" | "gitleaks";

export type AnalysisStatus = "PASS" | "FINDINGS" | "INCOMPLETE";

export type IsolationStatus = "verified" | "unverified" | "not_requested";

export interface ScanInput {
  /** Absolute directory created by Guardia for the resolved Git commit. */
  snapshotDir: string;
  /** Lockfile paths relative to snapshotDir. */
  lockfiles: string[];
}

export interface Finding {
  scanner: ScannerName;
  type: "dependency" | "secret";
  id: string;
  /** A path relative to the snapshot, never a secret value. */
  path: string;
  line?: number;
  /** A redacted description. It must never contain a secret value. */
  summary: string;
}

export interface ScannerDatabase {
  downloadedAt: string | null;
  sourceDate: string | null;
  sha256: string | null;
}

export interface ScannerResult {
  scanner: ScannerName;
  status: "ok" | "missing" | "error" | "unsupported";
  version: string | null;
  /** Only files for which this scanner confirmed a completed review. */
  filesAnalyzed: string[];
  /** Files or scopes for which coverage could not be established. */
  omitted: string[];
  findings: Finding[];
  /** Sanitized diagnostic; it must never include scanner output with secrets. */
  error?: string;
  database?: ScannerDatabase;
}

/** Dependency-injection boundary between the core and external tools. */
export type ScanAll = (input: ScanInput) => Promise<ScannerResult[]>;

export interface Snapshot {
  repository: string;
  /** Null when the snapshot represents the staged Git index rather than a commit. */
  commit: string | null;
  snapshotDir: string;
  lockfiles: string[];
  /** Git entries not copied into the snapshot, such as symlinks and gitlinks. */
  excluded: string[];
  /** Copy errors and rejected paths. Any value makes the snapshot incomplete. */
  omitted: string[];
  complete: boolean;
}

export interface AnalysisResult {
  status: AnalysisStatus;
  exitCode: 0 | 1 | 2;
  snapshot: Snapshot | null;
  snapshotError?: string;
  isolation: IsolationStatus;
  strictOffline: boolean;
  scanners: ScannerResult[];
  findings: Finding[];
}
