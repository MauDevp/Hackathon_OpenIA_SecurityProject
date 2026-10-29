# Adapters

One adapter per external tool, all behind the shared contract
(`contracts.ts`, a temporary copy of `src/contracts.ts`). Entry point:

```ts
import { scanAll } from "./adapters/index.ts";
const results = await scanAll({ snapshotDir: "/abs/path/to/snapshot", lockfiles: ["package-lock.json"] });
// results[0] is OSV-Scanner, results[1] is Gitleaks; both are always present.
```

| File | Role |
| --- | --- |
| `tools.ts` | pinned versions, binary names, environment variable names |
| `runner.ts` | runs a tool from the closed list with an argv vector, no shell, bounded time and output, allowlisted environment |
| `paths.ts` | snapshot validation; refuses paths that escape it through `..`, absolute paths or symlinks; lists files without following symlinks |
| `osv.ts` | OSV-Scanner in `--offline` mode, one run per lockfile, database metadata |
| `gitleaks.ts` | Gitleaks `dir` scan with the team config in `rules/gitleaks/guardia.toml`, redaction, safe fields only |
| `index.ts` | `scanAll` and `createScanAll` (adapter injection for tests) |

Configuration comes from the environment:

- `GUARDIA_OSV_SCANNER_BIN`, `GUARDIA_GITLEAKS_BIN`: absolute path of each
  binary. Without them the `PATH` is searched. The current directory and the
  snapshot are never searched.
- `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY`: database root. Default
  `.guardia/osv-db` under the working directory.

A missing tool or database is `status: "missing"`; a failed or interrupted run
or invalid output is `status: "error"`; lockfiles the tool cannot read are
`status: "unsupported"`. None of them is ever reported as a clean `ok`.
Observed tool behaviour and setup commands: `docs/scanners.md`.
