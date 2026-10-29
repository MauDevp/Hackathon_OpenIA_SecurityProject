// Temporary copy of the shared contract defined in the team agreement.
// Once `src/contracts.ts` lands on `main`, replace this file's body with:
//   export * from "../contracts.ts";
// Nothing else in `src/adapters/` has to change.

export type ScannerName = "osv" | "gitleaks";

export interface ScanInput {
  snapshotDir: string;       // Ruta absoluta de la copia preparada.
  lockfiles: string[];       // Rutas relativas al snapshot.
}

export interface Finding {
  scanner: ScannerName;
  type: "dependency" | "secret";
  id: string;                // ID de aviso o regla.
  path: string;              // Ruta relativa al snapshot.
  line?: number;
  summary: string;           // Sin secretos ni contenido sensible.
}

export interface ScannerResult {
  scanner: ScannerName;
  status: "ok" | "missing" | "error" | "unsupported";
  version: string | null;
  filesAnalyzed: string[];
  omitted: string[];
  findings: Finding[];
  error?: string;            // Mensaje sanitizado.
  database?: {
    downloadedAt: string | null;
    sourceDate: string | null;
    sha256: string | null;
  };
}

export type ScanAll = (input: ScanInput) => Promise<ScannerResult[]>;
