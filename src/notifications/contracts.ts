import type { AnalysisStatus, ScannerName } from "../contracts.js";

export type NotificationTrigger = "scheduled" | "pre_commit" | "manual";
export type NotificationStatus = "queued" | "sent" | "failed" | "skipped";
export type NotificationKind = "pass" | "findings" | "incomplete";

export interface NotificationEvent {
  id: string;
  occurredAt: string;
  /** Local alias, not an absolute repository path. */
  repository: string;
  ref: string;
  commit: string | null;
  status: AnalysisStatus;
  findingCount: number;
  scannerStates: Array<{ scanner: ScannerName; status: string }>;
  trigger: NotificationTrigger;
}

export interface NotificationTransport {
  send(event: NotificationEvent): Promise<{ providerMessageId: string }>;
}

export interface QueuedNotification {
  version: 1;
  dedupeKey: string;
  event: NotificationEvent;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
}

export function kindForStatus(status: AnalysisStatus): NotificationKind {
  if (status === "PASS") return "pass";
  if (status === "FINDINGS") return "findings";
  return "incomplete";
}
