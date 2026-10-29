# Adapters

One adapter per external tool. Each adapter:

- runs a pinned binary with a fixed argv list (never through a shell);
- enforces timeout and maximum output size;
- validates the tool output against its schema version;
- normalizes findings while preserving the original source, fingerprint,
  severity, confidence and coverage.

Planned adapters: OpenQodex (scan mode), OSV-Scanner (offline database),
Gitleaks, Semgrep CE (only with license-reviewed rules).
