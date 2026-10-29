# Guardia Offline

Local, deterministic and verifiable review of code changes and dependencies,
built on existing open source scanners.

> Status: research and planning. No working analysis yet.

## What it is

An integration experiment that extends the scan mode of OpenQodex with
OSV-Scanner running against a previously downloaded advisory database.
Every analysis states explicitly:

- which code snapshot and lockfiles were reviewed;
- which scanners and databases were used, and how old the advisories are;
- what was not covered.

Output is JSON/SARIF plus a human-readable summary, usable by a person, a
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

Before building a new platform, reproduce OpenQodex as is and check whether a
small upstream contribution covers the use cases. If upstream already solves
it, contribute or use it. Only if integration is unfeasible or rejected,
build an independent adapter compatible with its formats.

## Stack selected for the spike

| Component | Role | License |
| --- | --- | --- |
| OpenQodex | CLI, file selection, scanners, reports | Apache-2.0 |
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

## First tasks

See the backlog in the research report, section 15.3 (G-01 to G-10). Critical
path: G-02/G-04 -> G-05 -> G-06/G-07 -> G-08 to G-10 -> G-13/G-14 -> decision.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party scanners
keep their own licenses and are not redistributed here.
