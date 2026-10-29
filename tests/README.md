# Tests

- `unit/`: pure logic (normalizer, policy, cache fingerprint).
- `contract/`: adapter output parsing against pinned tool versions.
- `isolation/`: network denial, no writes to the analyzed repository,
  symlink and path traversal rejection, secret redaction in logs.

The current `core/` tests exercise snapshot safety, CLI argument/output checks,
policy ordering and redaction without needing external scanner binaries.

Run with `npm test`.
