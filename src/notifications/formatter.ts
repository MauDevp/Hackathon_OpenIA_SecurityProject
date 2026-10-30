import { createHash, randomUUID } from "node:crypto";

import type { AnalysisResult, Finding, ScannerResult } from "../contracts.js";
import { redactSecrets } from "../core/report.js";
import type { GuardiaReport } from "../core/report.js";
import type { NotificationEvent, NotificationTrigger } from "./contracts.js";

function scannerStates(scanners: ScannerResult[]): NotificationEvent["scannerStates"] {
  return scanners.map((scanner) => ({ scanner: scanner.scanner, status: scanner.status }));
}

function findingBreakdown(findings: Finding[]): NonNullable<NotificationEvent["findingBreakdown"]> {
  const counts = new Map<string, NonNullable<NotificationEvent["findingBreakdown"]>[number]>();
  for (const finding of findings) {
    const key = `${finding.scanner}:${finding.type}`;
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { scanner: finding.scanner, type: finding.type, count: 1 });
  }
  return [...counts.values()].sort((left, right) => `${left.scanner}:${left.type}`.localeCompare(`${right.scanner}:${right.type}`));
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
    findingBreakdown: findingBreakdown(result.findings),
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
    findingBreakdown: findingBreakdown(report.findings),
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
    findingBreakdown: [...(event.findingBreakdown ?? [])].sort((a, b) => `${a.scanner}:${a.type}`.localeCompare(`${b.scanner}:${b.type}`)),
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

function findingsDetail(event: NotificationEvent): string | null {
  if (event.status !== "FINDINGS") return null;
  const breakdown = event.findingBreakdown ?? [];
  if (breakdown.length === 0) return `Detalle: ${event.findingCount} hallazgo(s) detectado(s); abre el reporte local para revisar cada uno.`;
  const detail = breakdown.map((item) => {
    if (item.type === "dependency") {
      return `${item.count} vulnerabilidad${item.count === 1 ? "" : "es"} de dependencias (${item.scanner.toUpperCase()})`;
    }
    return `${item.count} posible${item.count === 1 ? "" : "s"} secreto${item.count === 1 ? "" : "s"} expuesto${item.count === 1 ? "" : "s"} (${item.scanner})`;
  });
  return `Detalle: ${detail.join(" · ")}.`;
}

/** The only text allowed to leave the machine through the WhatsApp transport. */
export function formatWhatsAppMessage(event: NotificationEvent): string {
  const commit = event.commit ? event.commit.slice(0, 7) : "cambios en staging";
  const title = event.status === "PASS" ? "✅ SIN HALLAZGOS" : event.status === "FINDINGS" ? "⚠️ HALLAZGOS" : "🟡 COBERTURA INCOMPLETA";
  const outcome = event.status === "PASS"
    ? "Resultado: no se detectaron hallazgos. Esto no garantiza seguridad absoluta."
    : event.status === "FINDINGS"
      ? `Resultado: se detectaron ${event.findingCount} hallazgo(s).`
      : "Resultado: no se completó toda la cobertura.";
  const lines = [
    `DMsecurity 🛡️ · ${title}`,
    ...(event.trigger === "onboarding" ? ["✅ Configuración completada. Resumen de la primera revisión:"] : []),
    `Repositorio: ${redactSecrets(event.repository)} · referencia: ${redactSecrets(event.ref)} · objetivo: ${redactSecrets(commit)}`,
    `Revisé: ${scannerReview(event)}`,
    outcome,
    ...(findingsDetail(event) ? [findingsDetail(event) as string] : []),
    improvement(event),
  ];
  return redactSecrets(lines.join("\n")).slice(0, 1024);
}
