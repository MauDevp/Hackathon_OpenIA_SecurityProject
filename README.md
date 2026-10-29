# Guardia Offline

Local, deterministic and verifiable review of code changes and dependencies,
built on existing open source scanners.

> Status: prototype CLI implemented. It reports unavailable scanners and
> unverified isolation as `INCOMPLETE`; it does not claim a clean repository is
> secure.

## What it is

An integration experiment that extends the scan mode of OpenQodex with
OSV-Scanner running against a previously downloaded advisory database.
Every analysis states explicitly:

- which code snapshot and lockfiles were reviewed;
- which scanners and databases were used, and how old the advisories are;
- what was not covered.

Output is JSON plus a human-readable summary, usable by a person, a
Git hook or an assistant. Once inputs are prepared, analysis needs no LLM,
remote service or credentials.

The final state is one of `PASS`, `FINDINGS` or `INCOMPLETE`. The absence of
findings is never presented as "secure".

## Why

Developers using AI assistants on private repositories, with intermittent
connectivity or data restrictions, may prefer a local review that says exactly
what was analyzed and with which data. This is a hypothesis to validate with
interviews and pilots, not a proven market.

Full reasoning, competitive analysis, costs and roadmap:
[docs/research](docs/research/investigacion-seguridad-ia-opensource.md).

## Decision rule

The v1 prototype uses a small, independent snapshot/orchestration core. The
recorded decision and criteria for a later OpenQodex evaluation are in
[docs/decisiones.md](docs/decisiones.md).

## Stack selected for the spike

| Component | Role | License |
| --- | --- | --- |
| OpenQodex | Candidate for later integration | Apache-2.0 |
| Node.js 22+ / TypeScript | Adapter runtime and language | MIT-style |
| OSV-Scanner | Dependencies and offline advisories | Apache-2.0 |
| Gitleaks | Secrets | MIT |
| Semgrep CE | Optional static analysis | LGPL-2.1-or-later |
| Git | Snapshot and change control | GPL-2.0 |
| SARIF / JSON | Findings interchange | OASIS |

## Repository layout

```
docs/        research report, threat model and guides
src/
  cli/       command-line entry point
  adapters/  one adapter per external scanner
  policy/    PASS / FINDINGS / INCOMPLETE decision
rules/       own or license-compatible rules only
fixtures/    synthetic repositories, no real secrets
tests/       unit, contract and isolation tests
schemas/     versioned JSON Schemas
examples/    opt-in CI and hook examples
```

## Getting started

```bash
nvm use           # Node 22
npm install
npm run build
node dist/cli/index.js
```

## Run a local scan

Install OSV-Scanner and Gitleaks separately, and prepare an OSV offline
database before a dependency scan. Guardia does not download either resource.
Details and limitations are in [docs/scanners.md](docs/scanners.md).

```bash
npm run build
node dist/cli/index.js scan \
  --repo /path/to/repository \
  --ref HEAD \
  --out /tmp/guardia-report.json
```

`--out` must be outside the repository. Add `--strict-offline` only when you
want the run to fail closed until a verified network-isolation mechanism is
available. The report's `isolation.status` is always `verified`, `unverified`
or `not_requested`.

Exit codes are `0` for `PASS`, `1` for `FINDINGS` and `2` for `INCOMPLETE`.
`PASS` means only that required stages completed with no findings.

## Design and limits

See [the architecture](docs/architecture.md), [scanner setup](docs/scanners.md)
and [the OpenQodex decision](docs/decisiones.md). The research backlog remains
in section 15.3 of the research report.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party scanners
keep their own licenses and are not redistributed here.
