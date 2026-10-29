# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub private vulnerability reporting on this repository, or contact the
maintainer directly through the profile listed in the repository. Include the
affected version or commit, reproduction steps and impact.

You will receive an acknowledgment and an estimated timeline. Response times
are a goal we measure, not yet a guarantee.

## Scope

- The CLI, adapters, policy engine and schemas in this repository.
- Isolation claims: network denial in strict mode, no writes to the analyzed
  repository, secret redaction, symlink and path traversal handling.

Vulnerabilities in third-party scanners (OpenQodex, OSV-Scanner, Gitleaks,
Semgrep) should be reported to their respective projects.

## Supported versions

No release has been published yet. Once released, the latest minor version
receives security fixes.
