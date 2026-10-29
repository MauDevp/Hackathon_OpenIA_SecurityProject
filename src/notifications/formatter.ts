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

function scannerReview(event: NotificationEvent): string {
  const state = new Map(event.scannerStates.map((item) => [item.scanner, item.status]));
  const osv = state.get("osv") === "ok" ? "dependencias conocidas (OSV)" : "dependencias: cobertura pendiente";
  const gitleaks = state.get("gitleaks") === "ok" ? "secretos expuestos (Gitleaks)" : "secretos: cobertura pendiente";
  return `${osv} · ${gitleaks}`;
}

function improvement(event: NotificationEvent): string {
  if (event.status === "PASS") {
    return "Mejora continua: mantén las dependencias actualizadas y vuelve a revisar cada cambio importante.";
  }
  if (event.status === "FINDINGS") {
    return "Mejora recomendada: abre el reporte local, actualiza dependencias afectadas y rota secretos si aplica.";
  }
  const unavailable = event.scannerStates.filter((item) => item.status !== "ok").map((item) => item.scanner).join(", ");
  return `Mejora necesaria: instala o corrige ${unavailable || "los componentes pendientes"} y vuelve a ejecutar la revisión.`;
}

/** The only text allowed to leave the machine through the WhatsApp transport. */
export function formatWhatsAppMessage(event: NotificationEvent): string {
  const commit = event.commit ? event.commit.slice(0, 7) : "staged changes";
  const title = event.status === "PASS" ? "✅ SIN HALLAZGOS" : event.status === "FINDINGS" ? "⚠️ HALLAZGOS" : "🟡 COBERTURA INCOMPLETA";
  const outcome = event.status === "PASS"
    ? "Resultado: no se detectaron hallazgos. Esto no garantiza seguridad absoluta."
    : event.status === "FINDINGS"
      ? `Resultado: se detectaron ${event.findingCount} hallazgo(s).`
      : "Resultado: no se completó toda la cobertura.";
  const lines = [
    `DMsecurity · ${title}`,
    `Proyecto: ${redactSecrets(event.repository)} · objetivo: ${redactSecrets(commit)}`,
    `Revisé: ${scannerReview(event)}`,
    outcome,
    improvement(event),
  ];
  return redactSecrets(lines.join("\n")).slice(0, 1024);
}
