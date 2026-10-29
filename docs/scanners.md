# External scanners: versions, setup and observed behaviour

This document records what was actually executed while building the adapters
in `src/adapters/`. Every command, exit code and JSON field below was observed
on the pinned versions on the date stated. Nothing here is inferred from
documentation alone unless it says so.

Environment used: Ubuntu 26.04.1 LTS, Linux x86_64, Node.js v24.21.0,
Git 2.53.0. Date of the observations: 2026-10-29 (UTC).

## 1. Pinned versions and provenance

| Tool | Version | Release asset | SHA-256 of installed binary |
| --- | --- | --- | --- |
| OSV-Scanner | 2.7.0 (built 2026-10-12, osv-scalibr 0.5.3) | `osv-scanner_linux_amd64` from `google/osv-scanner` release `v2.7.0` | `160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b` |
| Gitleaks | 8.30.1 | `gitleaks_8.30.1_linux_x64.tar.gz` from `gitleaks/gitleaks` release `v8.30.1` | `88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509` |

Both downloads were verified against the checksum files published with the
release (`osv-scanner_SHA256SUMS`, `gitleaks_8.30.1_checksums.txt`) with
`sha256sum --ignore-missing -c`; both reported `OK`. The SLSA provenance file
(`multiple.intoto.jsonl`) of OSV-Scanner was not verified (no `slsa-verifier`
installed). Gitleaks publishes no provenance attestation.

### Installation used here

Binaries live in `.guardia/tools/` (ignored by Git) so the user's system is
untouched. The adapters find them through either:

- `GUARDIA_OSV_SCANNER_BIN` / `GUARDIA_GITLEAKS_BIN` with an absolute path, or
- the `PATH`, for example `export PATH="$PWD/.guardia/tools:$PATH"`.

The adapters deliberately do **not** look inside the current directory or the
analyzed snapshot for executables: a hostile repository could plant one.

```bash
mkdir -p .guardia/tools dl && cd dl
curl -fsSLO https://github.com/google/osv-scanner/releases/download/v2.7.0/osv-scanner_linux_amd64
curl -fsSLO https://github.com/google/osv-scanner/releases/download/v2.7.0/osv-scanner_SHA256SUMS
sha256sum --ignore-missing -c osv-scanner_SHA256SUMS
install -m 0755 osv-scanner_linux_amd64 ../.guardia/tools/osv-scanner
curl -fsSLO https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
curl -fsSLO https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt
sha256sum --ignore-missing -c gitleaks_8.30.1_checksums.txt
tar -xzf gitleaks_8.30.1_linux_x64.tar.gz gitleaks && install -m 0755 gitleaks ../.guardia/tools/gitleaks
cd .. && .guardia/tools/osv-scanner --version && .guardia/tools/gitleaks version
```

Observed version output: `osv-scanner --version` prints several lines, the
first being `osv-scanner version: 2.7.0`; `gitleaks version` prints `8.30.1`.

## 2. OSV offline database

Variable: `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY`. Default used by the adapter:
`.guardia/osv-db/` (ignored by Git).

**Observed layout differs from the documentation.** The offline-mode docs say
`{dir}/osv-scanner/{ecosystem}/all.zip`; the 2.7.0 binary wrote and loaded
`{dir}/osv-scalibr/{ecosystem}/all.zip` (stderr: `Loaded npm local db from
.../.guardia/osv-db/osv-scalibr/npm/all.zip`). The adapter uses the observed
path.

Download command (network required, run once):

```bash
OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=$PWD/.guardia/osv-db \
  .guardia/tools/osv-scanner scan --offline --download-offline-databases \
  -L fixtures/adapters/npm-vulnerable/package-lock.json --format json
```

| Item | Value |
| --- | --- |
| Ecosystem downloaded | npm only (the fixture's ecosystem) |
| File | `.guardia/osv-db/osv-scalibr/npm/all.zip`, 219,383,955 bytes |
| Downloaded at | 2026-10-29T06:02:15Z |
| SHA-256 | `90f2720302141ae038bf3c1e7908d24d55ad130e385dd70ec2a6c50943c565c6` |
| Source date | not provided by the source (`null`) |

The same values are kept in `.guardia/osv-db/guardia-db-meta.json`, which the
adapter reads to fill `database.downloadedAt`. The adapter recomputes the
SHA-256 of the zip on every run, so a replaced database is reported as such.

`--offline` disables every network call; `--offline-vulnerabilities` only makes
the vulnerability lookup local. The adapter always uses `--offline`. Whether the
process really opens no sockets was **not verified** (no tracing tool was
used); see section 6.

## 3. OSV-Scanner: observed commands and exit codes

All runs with `--offline --format json` and the database above present unless
stated. Paths were absolute.

| Case | Command (abridged) | Exit | stdout | stderr (fixed fragment) |
| --- | --- | --- | --- | --- |
| A. `lodash@4.17.20` | `scan -L npm-vulnerable/package-lock.json` | 1 | `results[0]` with 5 vulnerabilities | — |
| B. `lodash@4.17.21` | `scan -L .../package-lock.json` | 1 | 3 vulnerabilities (2025–2026 advisories) | — |
| C. Empty database directory | same as A with empty `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY` | 127 | `{"results": []}` | `no offline version of the OSV database is available` |
| D. Lockfile path does not exist | `scan -L nope/package-lock.json` | 127 | empty | `failed to resolve path: stat ...: no such file or directory` |
| E. Unsupported file passed as lockfile | `scan -L secrets/config.py` | 127 | empty | `could not determine extractor suitable to this file` |
| F. Valid lockfile with zero packages | `scan -L empty/package-lock.json` | 128 | empty | `No package sources found` |
| G. Path containing a space | `scan -L "with space/package-lock.json"` | 1 | `source.path` echoes the path | — |
| H. Unknown flag | `scan --bogus` | 127 | — | `flag provided but not defined: -bogus` |
| J. `ms@2.1.3` (clean) | `scan -L npm-clean/package-lock.json` | 0 | `{"results": []}` | — |
| K. Two lockfiles, one clean | `scan -L vulnerable -L clean` | 1 | only the vulnerable source appears in `results[]` | — |
| L. Two lockfiles, one path invalid | `scan -L clean -L nope` | 127 | empty | `failed to resolve path` |

Consequences for the adapter:

- Exit `1` means findings, not failure. Exit `0` means the run completed with
  no findings. Exit `128` means nothing was analyzed. Exit `127` covers several
  unrelated failures, so the adapter classifies it with two fixed stderr
  fragments (`no offline version of the OSV database is available` →
  `missing`; `could not determine extractor` → `unsupported`) and otherwise
  reports `error`. Raw stderr is never copied into results.
- A clean lockfile leaves no trace in `results[]` (K), and one bad path aborts
  the whole invocation (L). The adapter therefore runs **one process per
  lockfile**: `filesAnalyzed` lists only lockfiles whose run exited 0 or 1.
- The database file for the lockfile's ecosystem is checked before running.
  Absent database → `missing` without executing the tool.
- `lodash@4.17.21` is no longer clean (B), so the clean fixture is `ms@2.1.3`.
- Cost of the per-lockfile design: each run loads the 219 MB npm database;
  on the test machine one lockfile took about 14 s. Acceptable for a handful
  of lockfiles; batch runs would need a different trade-off.

Confirmed JSON shape (case A): top-level `results[]` and `experimental_config`;
`results[].source.{path,type}` with `type: "lockfile"`;
`results[].packages[].package.{name,version,ecosystem,purl}`;
`results[].packages[].groups[].ids[]`; `results[].packages[].vulnerabilities[]`
are full OSV records with keys `id`, `summary`, `details`, `aliases`,
`modified`, `published`, `affected`, `references`, `severity`,
`database_specific`, `schema_version`. The adapter maps `id` and `summary`
only; `summary` is truncated to 200 characters.

Advisories observed for the fixture `lodash@4.17.20`: GHSA-29mw-wpgm-hmr9,
GHSA-35jh-r3h4-6jhm, GHSA-f23m-r3pf-42rh, GHSA-r5fr-rjxr-66jc,
GHSA-xxjr-mmjv-4gpg.

## 4. Gitleaks: observed commands and exit codes

Command used by the adapter:

```
gitleaks dir <snapshotDir> --config rules/gitleaks/guardia.toml \
  --report-format json --report-path <tmpfile> --redact --no-banner --no-color --exit-code 0
```

Observations on `fixtures/adapters/secrets/config.py`, which contains two
synthetic values (a `ghp_` token and an `AKIA` key, both invented):

| Case | Setup | Exit | Report |
| --- | --- | --- | --- |
| 1. Default config, fixture dir | no `--config` | 0 (`--exit-code 0`) | 2 findings: `github-pat` (line 4), `aws-access-token` (line 5) |
| 2. Hostile `.gitleaks.toml` inside the target, no `--config` | target config allowlists every path | 0 | `[]`, stderr `scanned ~0 bytes` |
| 3. Same hostile target **with** `--config rules/gitleaks/guardia.toml` | — | 0 | 2 findings again |
| 4. Target directory does not exist | — | 0 | `[]`, stderr `WRN skipping error="lstat ...: no such file or directory"` |
| 5. Unknown flag | `--bogus-flag` | 126 | usage text |
| 6. Findings without `--exit-code 0` | default | 1 | — |
| 7. Target contains only symlinks pointing outside | file symlink + directory symlink | 0 | `[]`, stderr `scanned ~0 bytes` |
| 8. Clean directory | one harmless file | 0 | `[]` |

Consequences for the adapter:

- Case 2 is the attack the team config prevents: a repository can silence
  Gitleaks entirely by shipping its own `.gitleaks.toml`. The adapter always
  passes `--config` (case 3 proves it wins) and records any `.gitleaks.toml`
  found in the snapshot under `omitted` as ignored.
- Case 4 is dangerous: a missing target looks exactly like a clean one. The
  adapter validates that `snapshotDir` exists and is a directory before running
  and walks it itself to produce `filesAnalyzed`.
- Case 7: Gitleaks 8.30.1 does **not** follow symlinks. Symlinked files and
  directories are not scanned; the adapter lists them under `omitted`.
- Observed after the first round, with the real binary: `# gitleaks:allow`
  comments in analyzed files silence findings even with an explicit
  `--config`; the adapter passes `--ignore-gitleaks-allow`, which restores
  them (verified). A `.gitleaksignore` at the snapshot root with absolute-path
  fingerprints also silences findings, and `--gitleaks-ignore-path` does
  **not** prevent it: Gitleaks loads `<target>/.gitleaksignore` in addition to
  the given path (tried an empty file, an empty directory and a nonexistent
  path; all still 0 findings). The flag's default is the current directory, so
  the adapter points it at an empty file in its temporary directory. When the
  snapshot root contains `.gitleaksignore`, the adapter still runs, keeps any
  findings, and returns `status: "error"` because coverage is then controlled
  by the repository. The clean fix belongs to the core: exclude
  `.gitleaksignore` when materializing the snapshot (open question, section 7).
- With `--exit-code 0`, exit `1` can only mean an execution error. Findings are
  read from the report file, written in a private temporary directory outside
  the snapshot.

Confirmed JSON report fields: `RuleID`, `Description`, `StartLine`, `EndLine`,
`StartColumn`, `EndColumn`, `Match`, `Secret`, `File`, `SymlinkFile`,
`Commit`, `Entropy`, `Author`, `Email`, `Date`, `Message`, `Tags`,
`Fingerprint`. With `--redact`, `Match` and `Secret` contain the literal
`REDACTED`. `File` echoes the path exactly as the target was passed (absolute
when the snapshot path is absolute); the adapter strips the snapshot prefix.
Only `RuleID`, `File`, `StartLine` and `Description` reach the contract.

Gitleaks is declared "feature complete" upstream and receives security fixes
only. Acceptable for the prototype; tracked as a risk.

## 5. Fixtures

| Path | Purpose |
| --- | --- |
| `fixtures/adapters/npm-vulnerable/package-lock.json` | `lodash@4.17.20`, 5 advisories in the database above |
| `fixtures/adapters/npm-clean/package-lock.json` | `ms@2.1.3`, no advisories in the database above |
| `fixtures/adapters/secrets/config.py` | two synthetic credentials matching `github-pat` and `aws-access-token` |

Fixture content is never executed, only passed as a path to the scanners.

## 6. Network isolation: not verified

The adapters pass `--offline` to OSV-Scanner and give both tools a minimal
environment (`PATH`, `HOME`, `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY`), but no
kernel-level or namespace-level isolation was applied and no syscall trace was
captured. The core must therefore report network isolation as **not
verified** and return `INCOMPLETE` when strict isolation is requested.

Path checks and tool execution are separate steps: the adapters resolve every
lockfile with `realpath` before running, but a snapshot that is modified
concurrently could still swap a file for a symlink in between. The snapshot
must be immutable while a scan runs.

## 7. Open questions for the team

- Whether `snapshotDir` arrives without symlinks that escape it. The adapter
  rejects lockfiles that resolve outside the snapshot and lists symlinks as
  omitted, but the cleanest fix is a snapshot without symlinks.
- The snapshot step should drop `.gitleaksignore` from the copy; Gitleaks
  honors it and the adapter can only report it (section 4).
- Only the npm database was downloaded. PyPI lockfiles will report `missing`
  until `osv-scalibr/PyPI/all.zip` is downloaded the same way.

## 8. Integration notes for the core

```ts
import { scanAll } from "./adapters/index.ts";

const results = await scanAll({ snapshotDir, lockfiles });
// results[0].scanner === "osv", results[1].scanner === "gitleaks", always both.
```

- `snapshotDir` must be absolute and exist; `lockfiles` are relative to it.
  Anything escaping the snapshot (`..`, absolute paths, symlinks) is rejected
  before any process starts and reported under `omitted` with `status: "error"`.
- Environment: `GUARDIA_OSV_SCANNER_BIN` / `GUARDIA_GITLEAKS_BIN` (absolute
  paths) or the tools on `PATH`; `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY`
  (default `.guardia/osv-db` relative to `process.cwd()`). `createScanAll({ env, cwd, timeoutMs })`
  lets the CLI pass an explicit environment instead of `process.env`.
- Status mapping for the report: any `missing` or `error` → `INCOMPLETE`;
  `unsupported` means the scanner had nothing it could analyze (for example no
  lockfiles) and should also be surfaced, since both scanners are required;
  findings present with both scanners `ok` → `FINDINGS`; otherwise `PASS`.
- `omitted` lists, per scanner, what was not analyzed and why: symlinks,
  ignored repository configuration, unsupported lockfiles, version mismatch.
  It is the coverage statement; print it.
- Network isolation is **not verified** by the adapters (section 6). Strict
  mode must report `INCOMPLETE`.

### Running the tests

```bash
node --test 'tests/adapters/**/*.test.ts'                      # simulations, no binaries needed
GUARDIA_INTEGRATION=1 PATH="$PWD/.guardia/tools:$PATH" \
OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY="$PWD/.guardia/osv-db" \
  node --test tests/adapters/integration.test.ts               # real binaries and database
```

Tests whose name starts with `[simulation]` use fake executables and prove how
the adapters react to a given tool output, not that the tool produces it.
Tests named `[integration]` ran against the pinned binaries on 2026-10-29.
