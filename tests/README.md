# Tests

- `unit/`: pure logic (normalizer, policy, cache fingerprint).
- `contract/`: adapter output parsing against pinned tool versions.
- `isolation/`: network denial, no writes to the analyzed repository,
  symlink and path traversal rejection, secret redaction in logs.

Run with `npm test`.
