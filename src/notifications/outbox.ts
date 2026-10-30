import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

import {
  notificationFailureFromError,
  type NotificationEvent,
  type NotificationFailure,
  type NotificationStatus,
  type NotificationTransport,
  type QueuedNotification,
} from "./contracts.js";
import { notificationDedupeKey } from "./formatter.js";
import { notificationStateDir } from "./state.js";

const MAX_ATTEMPTS = 5;

export interface OutboxOptions {
  stateDir?: string;
  now?: Date;
}

export interface QueueResult {
  status: NotificationStatus;
  dedupeKey: string;
}

export interface DeliveryResult extends QueueResult {
  attempts: number;
  failure?: NotificationFailure;
}

function directories(options: OutboxOptions): { root: string; pending: string; sent: string; failed: string } {
  const root = options.stateDir ?? notificationStateDir();
  return {
    root,
    pending: join(root, "outbox", "pending"),
    sent: join(root, "outbox", "sent"),
    failed: join(root, "outbox", "failed"),
  };
}

async function ensureDirectories(options: OutboxOptions): Promise<ReturnType<typeof directories>> {
  const paths = directories(options);
  await Promise.all(Object.values(paths).map(async (path) => mkdir(path, { recursive: true, mode: 0o700 })));
  return paths;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pendingPath(pending: string, key: string): string {
  return join(pending, `${key}.json`);
}

function delayForAttempt(attempts: number): number {
  return Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, attempts - 1)));
}

function parseQueued(raw: string): QueuedNotification | null {
  try {
    const item: unknown = JSON.parse(raw);
    if (!item || typeof item !== "object") return null;
    const queue = item as Partial<QueuedNotification>;
    if (queue.version !== 1 || typeof queue.dedupeKey !== "string" || !queue.event || typeof queue.attempts !== "number" || typeof queue.nextAttemptAt !== "string") {
      return null;
    }
    return queue as QueuedNotification;
  } catch {
    return null;
  }
}

/** Queues once per event fingerprint. Event payloads intentionally contain no credentials. */
export async function queueNotification(event: NotificationEvent, options: OutboxOptions = {}): Promise<QueueResult> {
  const paths = await ensureDirectories(options);
  const dedupeKey = notificationDedupeKey(event);
  const file = pendingPath(paths.pending, dedupeKey);
  if (await exists(file) || await exists(join(paths.sent, `${dedupeKey}.json`))) {
    return { status: "skipped", dedupeKey };
  }
  const item: QueuedNotification = {
    version: 1,
    dedupeKey,
    event,
    attempts: 0,
    nextAttemptAt: (options.now ?? new Date()).toISOString(),
  };
  try {
    await writeFile(file, `${JSON.stringify(item)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { status: "queued", dedupeKey };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: "skipped", dedupeKey };
    throw error;
  }
}

/** Attempts all due events; provider errors are reduced to a fixed safe error. */
export async function deliverPendingNotifications(
  transport: NotificationTransport,
  options: OutboxOptions = {},
): Promise<DeliveryResult[]> {
  const paths = await ensureDirectories(options);
  const now = options.now ?? new Date();
  const results: DeliveryResult[] = [];
  for (const entry of await readdir(paths.pending, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = join(paths.pending, entry.name);
    const item = parseQueued(await readFile(file, "utf8"));
    if (item === null) {
      await rename(file, join(paths.failed, entry.name));
      continue;
    }
    if (Date.parse(item.nextAttemptAt) > now.getTime()) {
      results.push({ status: "skipped", dedupeKey: item.dedupeKey, attempts: item.attempts });
      continue;
    }
    try {
      await transport.send(item.event);
      await rename(file, join(paths.sent, entry.name));
      results.push({ status: "sent", dedupeKey: item.dedupeKey, attempts: item.attempts + 1 });
    } catch (error) {
      const attempts = item.attempts + 1;
      const failure = notificationFailureFromError(error);
      if (attempts >= MAX_ATTEMPTS) {
        await writeFile(file, `${JSON.stringify({ ...item, attempts, lastError: "delivery failed", lastFailure: failure })}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(file, join(paths.failed, entry.name));
        results.push({ status: "failed", dedupeKey: item.dedupeKey, attempts, failure });
      } else {
        const nextAttemptAt = new Date(now.getTime() + delayForAttempt(attempts)).toISOString();
        await writeFile(file, `${JSON.stringify({ ...item, attempts, nextAttemptAt, lastError: "delivery failed", lastFailure: failure })}\n`, { encoding: "utf8", mode: 0o600 });
        results.push({ status: "queued", dedupeKey: item.dedupeKey, attempts, failure });
      }
    }
  }
  return results;
}
