# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-29

First usable prototype of the local scan workflow.

### Added

- `guardia scan --repo <path> --ref <git-ref> --out <report.json>` command
  with exit codes `0` (`PASS`), `1` (`FINDINGS`) and `2` (`INCOMPLETE`).
- Immutable commit snapshot built with `git cat-file`, without a checkout;
  symlinks and submodules are excluded and recorded.
- Shell-free process runner with timeout, output cap and environment
  allowlist. Executables are never resolved inside the analyzed repository.
- OSV-Scanner 2.7.0 adapter running `--offline` once per lockfile, with the
  advisory database SHA-256 and download metadata in the report.
- Gitleaks 8.30.1 adapter with the team configuration in
  `rules/gitleaks/guardia.toml`; repository-level allowlists,
  `.gitleaksignore` and inline `gitleaks:allow` comments are ignored.
- Coverage-first decision rule: a missing scanner, database or snapshot entry
  yields `INCOMPLETE` even when findings exist.
- JSON report (`formatVersion` `1.0`) written atomically with mode `0600`
  outside the analyzed repository, plus a redacted terminal summary.
- JSON Schema for report format `1.0` in `schemas/`, validated by the test
  suite.
- `--strict-offline` flag, which fails closed until a verified isolation
  mechanism exists.
- GitHub Actions workflow running typecheck, build, tests and a CLI smoke test
  on Node 22 and 24.
- Opt-in integration tests against the real binaries
  (`GUARDIA_INTEGRATION=1`).
- Research report (Markdown and PDF), architecture notes, scanner behaviour
  record and decision log under `docs/`.
- Synthetic fixtures: clean lockfile, vulnerable `lodash@4.17.20` lockfile
  and fake secrets.

[Unreleased]: https://github.com/MauDevp/Hackathon_OpenIA_SecurityProject/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MauDevp/Hackathon_OpenIA_SecurityProject/releases/tag/v0.1.0
