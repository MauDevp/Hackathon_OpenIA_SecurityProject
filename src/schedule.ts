import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { NotificationKind } from "./notifications/contracts.js";

export interface ScheduleEntry {
  version: 1;
  id: string;
  repository: string;
  ref: string;
  every: string;
  notify: "whatsapp" | "none";
  on: NotificationKind[];
  createdAt: string;
}

export interface AddScheduleInput {
  repository: string;
  ref: string;
  every: string;
  notify: "whatsapp" | "none";
  on: NotificationKind[];
}

function configurationDirectory(): string {
  return process.env.DMSECURITY_CONFIG_DIR
    ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "dmsecurity");
}

function schedulesPath(): string {
  return join(configurationDirectory(), "schedules.json");
}

function systemdDirectory(): string {
  return process.env.DMSECURITY_SYSTEMD_USER_DIR
    ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
}

function isSchedule(value: unknown): value is ScheduleEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ScheduleEntry>;
  return entry.version === 1
    && typeof entry.id === "string"
    && typeof entry.repository === "string"
    && typeof entry.ref === "string"
    && typeof entry.every === "string"
    && (entry.notify === "whatsapp" || entry.notify === "none")
    && Array.isArray(entry.on)
    && typeof entry.createdAt === "string";
}

function validateEvery(every: string): void {
  if (!/^\d+(?:m|h|d)$/.test(every) || every === "0m" || every === "0h" || every === "0d") {
    throw new Error("--every must be a positive duration such as 30m, 6h or 1d.");
  }
}

async function readSchedules(): Promise<ScheduleEntry[]> {
  try {
    const value: unknown = JSON.parse(await readFile(schedulesPath(), "utf8"));
    return Array.isArray(value) && value.every(isSchedule) ? value : [];
  } catch {
    return [];
  }
}

async function saveSchedules(schedules: ScheduleEntry[]): Promise<void> {
  const directory = configurationDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(schedulesPath(), `${JSON.stringify(schedules, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function listSchedules(): Promise<ScheduleEntry[]> {
  return readSchedules();
}

export async function addSchedule(input: AddScheduleInput): Promise<ScheduleEntry> {
  validateEvery(input.every);
  const schedules = await readSchedules();
  const basis = `${input.repository}\0${input.ref}\0${input.every}\0${input.notify}\0${input.on.join(",")}`;
  const id = createHash("sha256").update(basis).digest("hex").slice(0, 16);
  const existing = schedules.find((schedule) => schedule.id === id);
  if (existing) return existing;
  const entry: ScheduleEntry = {
    version: 1,
    id,
    repository: input.repository,
    ref: input.ref,
    every: input.every,
    notify: input.notify,
    on: input.on,
    createdAt: new Date().toISOString(),
  };
  schedules.push(entry);
  await saveSchedules(schedules);
  return entry;
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "")}"`;
}

export interface ScheduleUnitPaths {
  service: string;
  timer: string;
}

/** Writes disabled user-systemd units. Enabling them remains explicit. */
export async function writeScheduleUnits(entry: ScheduleEntry, scheduledScript: string): Promise<ScheduleUnitPaths> {
  const directory = systemdDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const base = `dmsecurity-${entry.id}`;
  const service = join(directory, `${base}.service`);
  const timer = join(directory, `${base}.timer`);
  const serviceBody = [
    "[Unit]",
    `Description=DMsecurity scan for ${entry.id}`,
    "",
    "[Service]",
    "Type=oneshot",
    `Environment=DMSECURITY_NODE_BIN=${systemdQuote(process.execPath)}`,
    `Environment=GUARDIA_NOTIFY=${entry.notify}`,
    `Environment=GUARDIA_NOTIFY_ON=${entry.on.join(",")}`,
    `ExecStart=${systemdQuote(scheduledScript)} ${systemdQuote(entry.repository)} ${systemdQuote(entry.ref)}`,
    "",
  ].join("\n");
  const timerBody = [
    "[Unit]",
    `Description=Schedule DMsecurity scan for ${entry.id}`,
    "",
    "[Timer]",
    "OnBootSec=2m",
    `OnUnitActiveSec=${entry.every}`,
    `Unit=${base}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  await writeFile(service, serviceBody, { encoding: "utf8", mode: 0o600 });
  await writeFile(timer, timerBody, { encoding: "utf8", mode: 0o600 });
  return { service, timer };
}

export async function removeSchedule(id: string): Promise<boolean> {
  const schedules = await readSchedules();
  const selected = schedules.find((schedule) => schedule.id === id);
  if (!selected) return false;
  await saveSchedules(schedules.filter((schedule) => schedule.id !== id));
  const base = `dmsecurity-${selected.id}`;
  await Promise.all([
    rm(join(systemdDirectory(), `${base}.service`), { force: true }),
    rm(join(systemdDirectory(), `${base}.timer`), { force: true }),
  ]);
  return true;
}
