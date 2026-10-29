# Policy

Decides the final state of an analysis from normalized findings and coverage:

- `PASS`: every required stage finished and no finding is above policy.
- `FINDINGS`: at least one blocking finding.
- `INCOMPLETE`: missing scanner or database, isolation not verifiable,
  timeout, unknown schema or unsupported scope.

Policy lives outside the analyzed repository. Suppressions record owner,
reason, scope and expiration, and are always shown in the report.
