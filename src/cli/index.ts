#!/usr/bin/env node
/**
 * Guardia CLI entry point.
 *
 * Planned flow (see docs/research, section 9.4):
 * detect stack and changes -> pin snapshot -> select rules and databases ->
 * run isolated scanners -> verify coverage -> prioritize findings -> report.
 *
 * Exit states: PASS, FINDINGS, INCOMPLETE. The absence of findings is never
 * reported as "secure".
 */

export type AnalysisStatus = "PASS" | "FINDINGS" | "INCOMPLETE";

function main(): void {
  process.stdout.write("guardia: not implemented yet. See docs/research for the plan.\n");
  process.exitCode = 2;
}

main();
