import { createHash, randomUUID } from "node:crypto";

import type { AnalysisResult, ScannerResult } from "../contracts.js";
import { redactSecrets } from "../core/report.js";
import type { GuardiaReport } from "../core/report.js";
import type { NotificationEvent, NotificationTrigger } from "./contracts.js";

function scannerStates(scanners: ScannerResult[]): NotificationEvent["scannerStates"] {
  return scanners.map((scanner) => ({ scanner: scanner.scanner, status: scanner.status }));
}

/** Converts the normalized local result into the minimum safe alert payload. */
export function eventFromAnalysis(
  result: AnalysisResult,
  repository: string,
  ref: string,
  trigger: NotificationTrigger,
): NotificationEvent {
  return {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    repository: redactSecrets(repository).slice(0, 80) || "repository",
    ref: redactSecrets(ref).slice(0, 80) || "unknown",
    commit: result.snapshot?.commit ?? null,
    status: result.status,
    findingCount: result.findings.length,
    scannerStates: scannerStates(result.scanners),
    trigger,
  };
}

/** Builds the same safe event from a report already written by the CLI. */
export function eventFromReport(
  report: GuardiaReport,
  repository: string,
  ref: string,
  trigger: NotificationTrigger,
): NotificationEvent {
  return {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    repository: redactSecrets(repository).slice(0, 80) || "repository",
    ref: redactSecrets(ref).slice(0, 80) || "unknown",
    commit: report.commit,
    status: report.status,
    findingCount: report.findings.length,
    scannerStates: report.scanners.map((scanner) => ({ scanner: scanner.scanner, status: scanner.status })),
    trigger,
  };
}

/** Stable fingerprint used to avoid repeating the same alert. */
export function notificationDedupeKey(event: NotificationEvent): string {
  const stable = JSON.stringify({
    repository: event.repository,
    ref: event.ref,
    commit: event.commit,
    status: event.status,
    findingCount: event.findingCount,
    scannerStates: [...event.scannerStates].sort((a, b) => a.scanner.localeCompare(b.scanner)),
    trigger: event.trigger,
  });
  return createHash("sha256").update(stable).digest("hex");
}

/** The only text allowed to leave the machine through the WhatsApp transport. */
export function formatWhatsAppMessage(event: NotificationEvent): string {
  const commit = event.commit ? event.commit.slice(0, 7) : "staged changes";
  const scanners = event.scannerStates.map((state) => `${state.scanner}: ${state.status}`).join(" · ");
  const action = event.status === "PASS"
    ? "Required scanners completed without findings. This is not a security guarantee."
    : event.status === "FINDINGS"
      ? "Review the local report before continuing."
      : "Coverage is incomplete; review the local installation and report.";
  const lines = [
    `DMsecurity · ${event.status}`,
    `Repo: ${redactSecrets(event.repository)} · target: ${redactSecrets(commit)}`,
    `Findings: ${event.findingCount} · ${scanners || "scanners unavailable"}`,
    action,
  ];
  return redactSecrets(lines.join("\n")).slice(0, 1024);
}
