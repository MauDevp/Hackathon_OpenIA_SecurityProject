# Contributing

Thanks for your interest. This project is in research and planning stage.

## Principles

- Contribute upstream first. If OpenQodex or OSV-Scanner can solve a need,
  propose it there before adding code here.
- The analyzed repository is untrusted, including its security configuration.
- Never run scripts from the analyzed repository during analysis.
- Never log, print or send the literal value of a secret.
- A missing scanner, database or isolation guarantee is `INCOMPLETE`, never
  `PASS`.

## Workflow

1. Open an issue describing the problem and the backlog item it relates to
   (G-01 to G-16 in the research report).
2. Branch from `main`.
3. Keep tests and docs in the same commit as the behavior they cover.
4. Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
5. Open a pull request. Security-sensitive changes need an independent review.

## Licensing

By contributing you agree that your contribution is licensed under
Apache-2.0. Do not add rules, parsers or plugins whose license has not been
reviewed and recorded.
