# Policy

Decides the final state of an analysis from normalized findings and coverage:

- `PASS`: every required stage finished and no finding is above policy.
- `FINDINGS`: at least one blocking finding.
- `INCOMPLETE`: missing scanner or database, isolation not verifiable,
  timeout, unknown schema or unsupported scope.

For v1 this logic lives in `src/core/orchestrator.ts` to keep the state
decision next to snapshot coverage. This folder remains reserved for a future
versioned policy with suppressions; it has no active implementation yet.
