# Fixtures

Synthetic repositories and lockfiles used by tests and pilots. Never commit
real secrets or real vulnerable production code. Secrets must use an obvious
synthetic prefix (for example `DEMO_`).

`synthetic-npm/` contains a valid npm lockfile and a visibly false demo token.
It is test input only: neither packages nor dependencies are installed or run.
