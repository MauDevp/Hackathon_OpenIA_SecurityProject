# Adapters

The first prototype exposes both required adapters from `index.ts`: OSV-Scanner
for lockfiles and Gitleaks for a snapshot tree. Each adapter:

- runs a pinned binary with a fixed argv list (never through a shell);
- enforces timeout and maximum output size;
- returns a result even when its binary or required local data is unavailable;
- normalizes only safe finding fields and never copies matched secret values;
- records only confirmed coverage under `filesAnalyzed` and unknown coverage
  under `omitted`.

The core injects the `ScanAll` function for tests, so no unit test needs an
installed scanner. Scanner setup and known limitations are documented in
[`docs/scanners.md`](../../docs/scanners.md).
