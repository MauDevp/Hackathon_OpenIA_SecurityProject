#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scanAll } from "../adapters/index.js";
import { scanOsv } from "../adapters/osv.js";
import type { AnalysisResult, ScanAll } from "../contracts.js";
import {
  adminChatMenu,
  adminDetailMessage,
  adminReviewMessage,
  acquireAdminChatLock,
  clearAdminChatActive,
  clearPendingDependencyRepair,
  clearPendingPnpmInstall,
  createPendingDependencyRepair,
  createPendingPnpmInstall,
  dependencyRepairArguments,
  dependencyRepairProposalMessage,
  isAdminChatActive,
  loadPendingDependencyRepair,
  loadPendingPnpmInstall,
  packageManagerForLockfiles,
  parseAdminCommand,
  pnpmInstallProposalMessage,
  pnpmVersionFromPackageManager,
  releaseAdminChatLock,
  unknownAdminCommandMessage,
} from "../admin/chat.js";
import { disableAdminChatService, enableAdminChatService, writeAdminChatUnit } from "../admin/service.js";
import { orchestrate, snapshotFailure } from "../core/orchestrator.js";
import { redactSecrets, type GuardiaReport, serializeReport, terminalSummary } from "../core/report.js";
import {
  assertOutputOutsideRepository,
  cleanupSnapshot,
  createIndexSnapshot,
  createSnapshot,
  SnapshotError,
} from "../core/snapshot.js";
import type { NotificationFailure, NotificationKind, NotificationStatus, NotificationTrigger } from "../notifications/contracts.js";
import { kindForStatus, notificationFailureFromError } from "../notifications/contracts.js";
import { eventFromAnalysis, eventFromReport } from "../notifications/formatter.js";
import { deliverPendingNotifications, queueNotification } from "../notifications/outbox.js";
import {
  createWhatsAppTransport,
  loginWhatsApp,
  openWhatsAppAdminChat,
  resetWhatsAppSession,
  whatsAppOptionsFromEnvironment,
} from "../notifications/whatsapp.js";
import { loadSecurityTarget, loadWhatsAppSettings, saveSecurityTarget, saveWhatsAppSettings } from "../notifications/settings.js";
import { notificationStateDir } from "../notifications/state.js";
import { addSchedule, listSchedules, removeSchedule, type ScheduleEntry, writeScheduleUnits } from "../schedule.js";
import {
  actionMenu,
  commandReference,
  detailedSecurityReport,
  securityCheckHeader,
  setupBanner,
  setupResult,
  setupStep,
  setupSuccess,
  setupWarning,
} from "./presentation.js";

const execFile = promisify(execFileCallback);
const installationRoot = fileURLToPath(new URL("../../", import.meta.url));

export interface ScanArguments {
  repo: string;
  ref: string;
  out: string;
  strictOffline: boolean;
  notify?: "whatsapp";
  notifyOn?: NotificationKind[];
}

export interface CheckStagedArguments {
  repo: string;
  out: string;
  strictOffline: boolean;
  notify?: "whatsapp";
  notifyOn?: NotificationKind[];
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function usage(): string {
  return [
    "Uso:",
    "  dmsecurity scan --repo <path> --ref <git-ref> --out <report.json> [--strict-offline] [--notify whatsapp] [--notify-on pass,findings,incomplete]",
    "  dmsecurity check-staged --repo <path> --out <report.json> [--strict-offline] [--notify whatsapp] [--notify-on pass,findings,incomplete]",
    "  dmsecurity onboard",
    "  dmsecurity --login | --logout",
    "  dmsecurity comandos",
    "  dmsecurity detailed-check",
    "  dmsecurity admin-chat [install|stop]",
    "  dmsecurity whatsapp login | reset | logout",
    "  dmsecurity notify --report <report.json> [--repo-alias <name>] [--ref <ref>] [--trigger scheduled|pre_commit|manual]",
    "  dmsecurity schedule add --repo <path> --ref <git-ref> --every <30m|6h|1d> --notify <whatsapp|none> [--on findings,incomplete]",
    "  dmsecurity schedule list | remove --id <id>",
    "  dmsecurity hook install --repo <path> [--mode warn|block] [--notify none|whatsapp] [--on pass,findings,incomplete]",
    "",
    "Report output must be outside the repository being analyzed.",
  ].join("\n");
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliError(`${flag} requires a value.`);
  return value;
}

function parseNotify(value: string): "whatsapp" {
  if (value !== "whatsapp") throw new CliError("--notify currently supports only 'whatsapp'.");
  return value;
}

function parseScanOptions(argv: string[], command: "scan" | "check-staged"): ScanArguments | CheckStagedArguments {
  if (argv[0] !== command) throw new CliError(`Expected the '${command}' command.\n${usage()}`);
  const values: Partial<Record<"repo" | "ref" | "out", string>> = {};
  let strictOffline = false;
  let notify: "whatsapp" | undefined;
  let notifyOn: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict-offline") {
      if (strictOffline) throw new CliError("--strict-offline was supplied more than once.");
      strictOffline = true;
      continue;
    }
    if (argument === "--notify") {
      if (notify !== undefined) throw new CliError("--notify was supplied more than once.");
      notify = parseNotify(nextValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--notify-on") {
      if (notifyOn !== undefined) throw new CliError("--notify-on was supplied more than once.");
      notifyOn = nextValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument !== "--repo" && argument !== "--ref" && argument !== "--out") {
      throw new CliError(`Unknown option ${JSON.stringify(argument)}.\n${usage()}`);
    }
    if (command === "check-staged" && argument === "--ref") throw new CliError("check-staged does not accept --ref.");
    const value = nextValue(argv, index, argument);
    const key = argument.slice(2) as "repo" | "ref" | "out";
    if (values[key] !== undefined) throw new CliError(`${argument} was supplied more than once.`);
    values[key] = value;
    index += 1;
  }
  if (!values.repo) throw new CliError("--repo is required.");
  if (command === "scan" && !values.ref) throw new CliError("--ref is required.");
  if (!values.out) throw new CliError("--out is required.");
  if (notifyOn !== undefined && notify === undefined) throw new CliError("--notify-on requires --notify whatsapp.");
  if (strictOffline && notify !== undefined) throw new CliError("--notify whatsapp cannot be used with --strict-offline.");
  const notificationOptions = notifyOn === undefined ? {} : { notifyOn: parseNotificationKinds(notifyOn) };
  if (command === "scan") {
    return { repo: values.repo, ref: values.ref as string, out: values.out, strictOffline, ...(notify ? { notify } : {}), ...notificationOptions };
  }
  return { repo: values.repo, out: values.out, strictOffline, ...(notify ? { notify } : {}), ...notificationOptions };
}

export function parseArguments(argv: string[]): ScanArguments {
  return parseScanOptions(argv, "scan") as ScanArguments;
}

export function parseCheckStagedArguments(argv: string[]): CheckStagedArguments {
  return parseScanOptions(argv, "check-staged") as CheckStagedArguments;
}

async function validateRepositoryDirectory(repository: string): Promise<string> {
  try {
    const info = await stat(repository);
    if (!info.isDirectory()) throw new CliError("--repo must name an existing directory.");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("--repo must name an existing directory.");
  }
  return resolve(repository);
}

async function validateGitRepository(repository: string): Promise<string> {
  const resolved = await validateRepositoryDirectory(repository);
  try {
    const output = await execFile("git", ["-C", resolved, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
    if (output.stdout.trim() !== "true") throw new Error("not a work tree");
  } catch {
    throw new CliError("The repository selected during setup must be a Git work tree.");
  }
  return resolved;
}

async function validateReference(repository: string, reference: string): Promise<void> {
  try {
    await execFile("git", ["-C", repository, "rev-parse", "--verify", `${reference}^{commit}`], { encoding: "utf8" });
  } catch {
    throw new CliError("The branch or ref selected during setup does not resolve to a commit.");
  }
}

async function writeReport(path: string, result: AnalysisResult): Promise<void> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.guardia-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporary, serializeReport(result), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } catch {
    throw new CliError("Could not write the report at the requested output path.");
  }
}

export interface ExecuteOptions {
  scanAll?: ScanAll;
}

async function executeWithSnapshot(
  repository: string,
  outputInput: string,
  strictOffline: boolean,
  makeSnapshot: () => Promise<import("../contracts.js").Snapshot>,
  dependencies: ExecuteOptions,
): Promise<{ result: AnalysisResult; output: string }> {
  let output: string;
  try {
    output = await assertOutputOutsideRepository(repository, outputInput);
  } catch (error) {
    if (error instanceof SnapshotError) throw new CliError(error.message);
    throw new CliError("--out could not be resolved safely.");
  }
  const isolation = strictOffline ? "unverified" : "not_requested";
  let result: AnalysisResult;
  try {
    const snapshot = await makeSnapshot();
    try {
      result = await orchestrate({ snapshot, scanAll: dependencies.scanAll ?? scanAll, strictOffline, isolation });
    } finally {
      await cleanupSnapshot(snapshot);
    }
  } catch (error) {
    const message = error instanceof SnapshotError ? error.message : "A safe snapshot could not be prepared.";
    result = snapshotFailure(message, strictOffline, isolation);
  }
  await writeReport(output, result);
  return { result, output };
}

/** Executes one committed-ref scan and always removes the snapshot it created. */
export async function executeScan(args: ScanArguments, dependencies: ExecuteOptions = {}): Promise<{ result: AnalysisResult; output: string }> {
  const repository = await validateRepositoryDirectory(args.repo);
  return executeWithSnapshot(repository, args.out, args.strictOffline, () => createSnapshot(repository, args.ref), dependencies);
}

/** Executes a read-only scan of staged index blobs, suitable for a pre-commit hook. */
export async function executeCheckStaged(args: CheckStagedArguments, dependencies: ExecuteOptions = {}): Promise<{ result: AnalysisResult; output: string }> {
  const repository = await validateRepositoryDirectory(args.repo);
  return executeWithSnapshot(repository, args.out, args.strictOffline, () => createIndexSnapshot(repository), dependencies);
}

function repositoryAlias(path: string): string {
  return basename(resolve(path)) || "repository";
}

function defaultNotificationKinds(): NotificationKind[] {
  return ["findings", "incomplete"];
}

function parseNotificationKinds(value: string | undefined): NotificationKind[] {
  if (!value) return defaultNotificationKinds();
  const parsed = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (parsed.length === 0 || parsed.some((item) => item !== "pass" && item !== "findings" && item !== "incomplete")) {
    throw new CliError("--on must be a comma-separated list of pass,findings,incomplete.");
  }
  return [...new Set(parsed)] as NotificationKind[];
}

interface NotificationAttempt {
  status: NotificationStatus;
  failure?: NotificationFailure;
}

function notificationFailureDetails(failure: NotificationFailure): string {
  const details: Record<NotificationFailure["stage"], { where: string; reason: string }> = {
    configuration: {
      where: "configuración",
      reason: "falta o no es válida la configuración local de WhatsApp.",
    },
    connection: {
      where: "conexión",
      reason: "la sesión vinculada no pudo conectarse a WhatsApp.",
    },
    recipient: {
      where: "destinatario",
      reason: "el número configurado no se encontró en WhatsApp.",
    },
    delivery: {
      where: "envío",
      reason: "WhatsApp no confirmó la entrega del mensaje.",
    },
  };
  const detail = details[failure.stage];
  return `Alertas de WhatsApp · dónde falló: ${detail.where} · motivo: ${detail.reason}`;
}

function writeNotificationResult(result: NotificationAttempt): void {
  process.stdout.write(`notification: ${result.status}\n`);
  if (result.failure) process.stdout.write(`${notificationFailureDetails(result.failure)}\n`);
}

async function notifyEvent(event: ReturnType<typeof eventFromAnalysis>): Promise<NotificationAttempt> {
  const queued = await queueNotification(event);
  // The administrator chat owns the QR-linked socket while active. Let it
  // drain the private outbox instead of opening a competing WhatsApp session.
  if (process.env.DMSECURITY_WHATSAPP_QUEUE_ONLY === "1" || await isAdminChatActive()) {
    return { status: queued.status };
  }
  try {
    const transport = createWhatsAppTransport(await whatsAppOptionsFromEnvironment());
    const deliveries = await deliverPendingNotifications(transport);
    const delivery = deliveries.find((item) => item.dedupeKey === queued.dedupeKey);
    if (!delivery?.failure) return { status: delivery?.status ?? queued.status };
    return { status: delivery.status, failure: delivery.failure };
  } catch (error) {
    // Transport failure is intentionally decoupled from the local scan verdict.
    return { status: queued.status, failure: notificationFailureFromError(error) };
  }
}

async function notifyAnalysis(
  result: AnalysisResult,
  repository: string,
  ref: string,
  trigger: NotificationTrigger,
  kinds = defaultNotificationKinds(),
): Promise<NotificationAttempt> {
  if (!kinds.includes(kindForStatus(result.status))) return { status: "skipped" };
  return notifyEvent(eventFromAnalysis(result, repositoryAlias(repository), ref, trigger));
}

function parseNotifyCommand(argv: string[]): { report: string; repository: string; ref: string; trigger: NotificationTrigger; kinds: NotificationKind[] } {
  let report: string | undefined;
  let repository = "repository";
  let ref = "HEAD";
  let trigger: NotificationTrigger = "manual";
  let on: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--report" && argument !== "--repo-alias" && argument !== "--ref" && argument !== "--trigger" && argument !== "--on") {
      throw new CliError(`Unknown option ${JSON.stringify(argument)}.`);
    }
    const value = nextValue(argv, index, argument);
    if (argument === "--report") report = value;
    if (argument === "--repo-alias") repository = value;
    if (argument === "--ref") ref = value;
    if (argument === "--trigger") {
      if (value !== "manual" && value !== "scheduled" && value !== "pre_commit") throw new CliError("--trigger must be manual, scheduled or pre_commit.");
      trigger = value;
    }
    if (argument === "--on") on = value;
    index += 1;
  }
  if (!report) throw new CliError("notify requires --report.");
  return { report, repository, ref, trigger, kinds: parseNotificationKinds(on) };
}

function isGuardiaReport(value: unknown): value is GuardiaReport {
  return Boolean(value) && typeof value === "object"
    && ["PASS", "FINDINGS", "INCOMPLETE"].includes((value as { status?: unknown }).status as string)
    && Array.isArray((value as { findings?: unknown }).findings)
    && Array.isArray((value as { scanners?: unknown }).scanners);
}

async function runNotify(argv: string[]): Promise<number> {
  const input = parseNotifyCommand(argv);
  let document: unknown;
  try {
    document = JSON.parse(await readFile(input.report, "utf8"));
  } catch {
    throw new CliError("--report must be a readable DMsecurity JSON report.");
  }
  if (!isGuardiaReport(document)) throw new CliError("--report is not a supported DMsecurity report.");
  if (!input.kinds.includes(kindForStatus(document.status))) {
    process.stdout.write("notification: skipped\n");
    return 0;
  }
  const notification = await notifyEvent(eventFromReport(document, input.repository, input.ref, input.trigger));
  writeNotificationResult(notification);
  return 0;
}

async function runWhatsApp(argv: string[]): Promise<number> {
  if (argv.length !== 2 || (argv[1] !== "login" && argv[1] !== "reset" && argv[1] !== "logout")) {
    throw new CliError("Expected 'whatsapp login', 'whatsapp logout' or 'whatsapp reset'.");
  }
  if (argv[1] === "reset" || argv[1] === "logout") {
    if (await isAdminChatActive()) {
      throw new CliError("Detén primero el chat de administrador con 'dmsecurity admin-chat stop' para cerrar la sesión de WhatsApp de forma segura.");
    }
    await resetWhatsAppSession();
    process.stdout.write("Sesión local de WhatsApp cerrada. Elimina también el dispositivo DMsecurity desde WhatsApp en el celular.\n");
    return 0;
  }
  if (await isAdminChatActive()) {
    throw new CliError("El chat de administrador ya usa la sesión de WhatsApp. Deténlo con 'dmsecurity admin-chat stop' antes de volver a vincularla.");
  }
  await loginWhatsApp();
  process.stdout.write("WhatsApp linked.\n");
  return 0;
}

function parseScheduleAdd(argv: string[]): { repo: string; ref: string; every: string; notify: "whatsapp" | "none"; on: NotificationKind[] } {
  const values: Partial<Record<"repo" | "ref" | "every" | "notify" | "on", string>> = {};
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--repo" && argument !== "--ref" && argument !== "--every" && argument !== "--notify" && argument !== "--on") {
      throw new CliError(`Unknown option ${JSON.stringify(argument)}.`);
    }
    const value = nextValue(argv, index, argument);
    const key = argument.slice(2) as "repo" | "ref" | "every" | "notify" | "on";
    if (values[key] !== undefined) throw new CliError(`${argument} was supplied more than once.`);
    values[key] = value;
    index += 1;
  }
  if (!values.repo || !values.ref || !values.every || !values.notify) throw new CliError("schedule add requires --repo, --ref, --every and --notify.");
  if (values.notify !== "whatsapp" && values.notify !== "none") throw new CliError("--notify must be whatsapp or none.");
  return { repo: values.repo, ref: values.ref, every: values.every, notify: values.notify, on: parseNotificationKinds(values.on) };
}

const scheduledScript = fileURLToPath(new URL("../../scripts/scheduled-scan.sh", import.meta.url));

async function runSchedule(argv: string[]): Promise<number> {
  if (argv[1] === "list") {
    process.stdout.write(`${JSON.stringify(await listSchedules(), null, 2)}\n`);
    return 0;
  }
  if (argv[1] === "remove") {
    const id = argv[2] === "--id" ? argv[3] : undefined;
    if (!id) throw new CliError("schedule remove requires --id.");
    await disableSchedule(id);
    if (!(await removeSchedule(id))) throw new CliError("No schedule exists with that id.");
    await reloadUserSystemd();
    process.stdout.write(`schedule removed: ${id}\n`);
    return 0;
  }
  if (argv[1] !== "add") throw new CliError("Expected schedule add, list or remove.");
  const input = parseScheduleAdd(argv);
  const repository = await validateRepositoryDirectory(input.repo);
  const entry = await addSchedule({ ...input, repository });
  const units = await writeScheduleUnits(entry, scheduledScript);
  process.stdout.write([
    `schedule: ${entry.id}`,
    `timer: ${units.timer}`,
    "Enable explicitly with:",
    `  systemctl --user daemon-reload && systemctl --user enable --now dmsecurity-${entry.id}.timer`,
  ].join("\n") + "\n");
  return 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function installHook(
  repo: string,
  mode: "warn" | "block",
  notify: "none" | "whatsapp",
  on: string,
): Promise<string> {
  parseNotificationKinds(on);
  const repository = await validateRepositoryDirectory(repo);
  let hooks: string;
  try {
    const output = await execFile("git", ["-C", repository, "rev-parse", "--git-path", "hooks"], { encoding: "utf8" });
    hooks = output.stdout.trim();
  } catch {
    throw new CliError("--repo must be a Git repository to install a hook.");
  }
  const hookDirectory = isAbsolute(hooks) ? hooks : resolve(repository, hooks);
  const hookPath = join(hookDirectory, "pre-commit");
  try {
    await lstat(hookPath);
    throw new CliError("A pre-commit hook already exists; DMsecurity will not overwrite it.");
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CliError("Could not inspect the existing pre-commit hook.");
  }
  const script = fileURLToPath(new URL("../../scripts/pre-commit.sh", import.meta.url));
  await mkdir(hookDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    hookPath,
    `#!/usr/bin/env bash\nexport DMSECURITY_NODE_BIN=${shellQuote(process.execPath)}\nexec ${shellQuote(script)} --mode ${shellQuote(mode)} --notify ${shellQuote(notify)} --on ${shellQuote(on)}\n`,
    { encoding: "utf8", mode: 0o700, flag: "wx" },
  );
  await chmod(hookPath, 0o700);
  return hookPath;
}

async function runHook(argv: string[]): Promise<number> {
  if (argv[1] !== "install") throw new CliError("Expected hook install.");
  let repo: string | undefined;
  let mode: "warn" | "block" = "block";
  let notify: "none" | "whatsapp" = "none";
  let on = "findings,incomplete";
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--repo" && argument !== "--mode" && argument !== "--notify" && argument !== "--on") throw new CliError(`Unknown option ${JSON.stringify(argument)}.`);
    const value = nextValue(argv, index, argument);
    if (argument === "--repo") repo = value;
    if (argument === "--mode") {
      if (value !== "warn" && value !== "block") throw new CliError("--mode must be warn or block.");
      mode = value;
    }
    if (argument === "--notify") {
      if (value !== "none" && value !== "whatsapp") throw new CliError("--notify must be none or whatsapp.");
      notify = value;
    }
    if (argument === "--on") on = value;
    index += 1;
  }
  if (!repo) throw new CliError("hook install requires --repo.");
  const hookPath = await installHook(repo, mode, notify, on);
  process.stdout.write(`hook installed: ${hookPath}\n`);
  return 0;
}

function enabled(answer: string, fallback: boolean): boolean {
  const value = answer.trim().toLowerCase();
  if (!value) return fallback;
  if (["y", "yes", "s", "si", "sí"].includes(value)) return true;
  if (["n", "no"].includes(value)) return false;
  throw new CliError("Responde sí o no.");
}

async function enableSchedule(id: string): Promise<void> {
  try {
    await execFile("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
    await execFile("systemctl", ["--user", "enable", "--now", `dmsecurity-${id}.timer`], { encoding: "utf8" });
  } catch {
    throw new CliError("Could not activate the user systemd timer. The schedule files were created but not enabled.");
  }
}

async function disableSchedule(id: string): Promise<void> {
  try {
    await execFile("systemctl", ["--user", "disable", "--now", `dmsecurity-${id}.timer`], { encoding: "utf8" });
  } catch {
    // Removing the local configuration must still work when systemd is unavailable.
  }
}

async function reloadUserSystemd(): Promise<void> {
  try {
    await execFile("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  } catch {
    // The unit files are already removed; a future user-session reload is sufficient.
  }
}

function firstScanReportPath(): string {
  return join(notificationStateDir(), "onboarding", `first-scan-${Date.now()}.json`);
}

function useInstalledScannersForOnboarding(): void {
  const guardiaDirectory = process.env.GUARDIA_DIR ?? join(installationRoot, ".guardia");
  process.env.GUARDIA_OSV_SCANNER_BIN ??= join(guardiaDirectory, "tools", "osv-scanner");
  process.env.GUARDIA_GITLEAKS_BIN ??= join(guardiaDirectory, "tools", "gitleaks");
  process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY ??= join(guardiaDirectory, "osv-db");
}

function interactiveCheckReportPath(): string {
  return join(notificationStateDir(), "interactive-checks", `detailed-${Date.now()}.json`);
}

async function interactiveSecurityTarget(): Promise<{ repository: string; reference: string }> {
  const saved = await loadSecurityTarget();
  const fallback = saved ?? [...(await listSchedules())].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!fallback) {
    throw new CliError("No hay un repositorio configurado para revisar. Ejecuta 'dmsecurity onboard' primero.");
  }
  const repository = await validateGitRepository(fallback.repository);
  await validateReference(repository, fallback.ref);
  return { repository, reference: fallback.ref };
}

async function withActivity<T>(message: string, action: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) {
    process.stdout.write(`▶ ${message}\n`);
    return action();
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  const render = () => process.stdout.write(`\r\x1B[2K${frames[frame] ?? "·"} ${message}`);
  render();
  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    render();
  }, 90);
  try {
    const result = await action();
    clearInterval(timer);
    process.stdout.write(`\r\x1B[2K✓ ${message} terminado.\n`);
    return result;
  } catch (error) {
    clearInterval(timer);
    process.stdout.write(`\r\x1B[2K✕ ${message} no pudo terminar.\n`);
    throw error;
  }
}

async function runDetailedSecurityCheck(): Promise<number> {
  const target = await interactiveSecurityTarget();
  process.stdout.write(securityCheckHeader("detallada", repositoryAlias(target.repository), target.reference));
  useInstalledScannersForOnboarding();
  const scan = await withActivity(
    "Revisando dependencias vulnerables, secretos expuestos y cobertura",
    () => executeScan({
      repo: target.repository,
      ref: target.reference,
      out: interactiveCheckReportPath(),
      strictOffline: false,
    }),
  );
  process.stdout.write(terminalSummary(scan.result, scan.output));
  process.stdout.write(detailedSecurityReport(scan.result));
  return 0;
}

function adminChatReportPath(kind: "review" | "repair"): string {
  return join(notificationStateDir(), "admin-chat", `${kind}-${Date.now()}.json`);
}

async function runAdminReview(): Promise<{ result: AnalysisResult; repository: string; reference: string }> {
  const target = await interactiveSecurityTarget();
  useInstalledScannersForOnboarding();
  const scan = await executeScan({
    repo: target.repository,
    ref: target.reference,
    out: adminChatReportPath("review"),
    strictOffline: false,
  });
  return { result: scan.result, repository: target.repository, reference: target.reference };
}

async function workingTreeIsClean(repository: string): Promise<boolean> {
  try {
    const output = await execFile("git", ["-C", repository, "status", "--porcelain"], { encoding: "utf8", maxBuffer: 64 * 1024 });
    return output.stdout.trim() === "";
  } catch {
    throw new CliError("No se pudo comprobar si el árbol de trabajo está limpio.");
  }
}

async function resolveGitCommit(repository: string, reference: string): Promise<string> {
  try {
    const output = await execFile("git", ["-C", repository, "rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const commit = output.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("invalid commit");
    return commit;
  } catch {
    throw new CliError("No se pudo verificar el commit actual del repositorio antes de reparar.");
  }
}

async function lockfileDigest(repository: string, lockfile: string): Promise<string> {
  if (!lockfile || lockfile.includes("\0") || isAbsolute(lockfile)) {
    throw new CliError("El lockfile de la propuesta no es seguro.");
  }
  const root = await realpath(repository);
  const candidate = resolve(root, lockfile);
  const between = relative(root, candidate);
  if (between === "" || between === ".." || between.startsWith(`..${sep}`) || isAbsolute(between)) {
    throw new CliError("El lockfile de la propuesta queda fuera del repositorio.");
  }
  let file: Awaited<ReturnType<typeof lstat>>;
  try {
    file = await lstat(candidate);
  } catch {
    throw new CliError("El lockfile propuesto ya no existe.");
  }
  if (!file.isFile() || file.isSymbolicLink() || file.size > 64 * 1024 * 1024) {
    throw new CliError("El lockfile propuesto no es un archivo regular seguro.");
  }
  return createHash("sha256").update(await readFile(candidate)).digest("hex");
}

function userLocalBin(): string {
  return join(homedir(), ".local", "bin");
}

function localPnpmBinary(): string {
  return join(userLocalBin(), "pnpm");
}

function addUserLocalBinToPath(): void {
  const directory = userLocalBin();
  const current = process.env.PATH ?? "";
  if (!current.split(":").includes(directory)) process.env.PATH = `${directory}:${current}`;
}

/** Prefer the fixed per-user pnpm location, so an existing service can use it
 * immediately after an approved bootstrap without waiting for a restart. */
async function packageManagerCommand(packageManager: "npm" | "pnpm"): Promise<string | null> {
  const candidates = packageManager === "pnpm" ? [localPnpmBinary(), "pnpm"] : ["npm"];
  for (const candidate of candidates) {
    try {
      await execFile(candidate, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
      return candidate;
    } catch {
      // Try the next fixed, local candidate.
    }
  }
  return null;
}

async function installedPackageManagerVersion(command: string): Promise<string | null> {
  try {
    const output = await execFile(command, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
    const version = output.stdout.trim().split(/\s+/, 1)[0] ?? "";
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

async function packageManagerAvailable(packageManager: "npm" | "pnpm"): Promise<boolean> {
  return (await packageManagerCommand(packageManager)) !== null;
}

async function packageManagerVersionFromRepository(repository: string): Promise<string | null> {
  try {
    // Reuse the repository-bound file validation before parsing project data.
    // In particular, package.json may not be a symlink outside the target.
    await lockfileDigest(repository, "package.json");
    const packageJson = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as { packageManager?: unknown };
    return pnpmVersionFromPackageManager(packageJson.packageManager);
  } catch {
    return null;
  }
}

/** npm arguments are entirely fixed in code; WhatsApp never contributes text. */
function pnpmInstallationArguments(version: string): string[] {
  return [
    "install",
    "--global",
    "--prefix", join(homedir(), ".local"),
    `pnpm@${version}`,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org",
  ];
}

async function applyConfirmedPnpmInstall(
  proposal: NonNullable<Awaited<ReturnType<typeof loadPendingPnpmInstall>>>,
): Promise<string> {
  const currentTarget = await interactiveSecurityTarget();
  if (currentTarget.repository !== proposal.repository || currentTarget.reference !== proposal.ref) {
    return [
      "DMsecurity 🛡️ · instalación cancelada",
      "El repositorio o la referencia configurados cambiaron desde la propuesta.",
      "Solicita INSTALAR PNPM de nuevo para revisar el objetivo actual.",
    ].join("\n");
  }
  const [headCommit, referenceCommit] = await Promise.all([
    resolveGitCommit(proposal.repository, "HEAD"),
    resolveGitCommit(proposal.repository, proposal.ref),
  ]);
  if (headCommit !== proposal.commit || referenceCommit !== proposal.commit) {
    return [
      "DMsecurity 🛡️ · instalación cancelada",
      "La rama activa o la referencia revisada cambió desde la propuesta.",
      "Solicita INSTALAR PNPM otra vez para no instalar una herramienta para un objetivo distinto.",
    ].join("\n");
  }
  if (await lockfileDigest(proposal.repository, "package.json") !== proposal.packageJsonSha256) {
    return [
      "DMsecurity 🛡️ · instalación cancelada",
      "package.json cambió desde la propuesta. Solicita INSTALAR PNPM de nuevo para verificar la versión requerida.",
    ].join("\n");
  }
  const expectedVersion = await packageManagerVersionFromRepository(proposal.repository);
  if (expectedVersion !== proposal.pnpmVersion) {
    return [
      "DMsecurity 🛡️ · instalación cancelada",
      "El repositorio ya no declara la misma versión de pnpm. Solicita una nueva propuesta.",
    ].join("\n");
  }
  const npm = await packageManagerCommand("npm");
  if (!npm) {
    return [
      "DMsecurity 🛡️ · instalación no aplicada",
      "npm no está disponible en este equipo, por lo que no puedo instalar pnpm de forma segura.",
      "Instala o repara Node.js/npm localmente y vuelve a solicitar INSTALAR PNPM.",
    ].join("\n");
  }
  try {
    await execFile(npm, pnpmInstallationArguments(proposal.pnpmVersion), {
      cwd: installationRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
      },
    });
  } catch {
    return [
      "DMsecurity 🛡️ · instalación no aplicada",
      `No se pudo instalar pnpm@${proposal.pnpmVersion} desde el registro oficial de npm.`,
      "Comprueba la conexión y permisos de ~/.local; no se expone la salida de npm por WhatsApp.",
    ].join("\n");
  }
  addUserLocalBinToPath();
  const installedVersion = await installedPackageManagerVersion(localPnpmBinary());
  if (installedVersion !== proposal.pnpmVersion) {
    return [
      "DMsecurity 🛡️ · instalación incompleta",
      `npm terminó, pero ~/.local/bin/pnpm no informó la versión esperada (${proposal.pnpmVersion}).`,
      "No se habilitará la reparación desde WhatsApp hasta que verifiques la instalación local.",
    ].join("\n");
  }
  await clearPendingPnpmInstall();
  return [
    "DMsecurity 🛡️ · PNPM instalado",
    `Versión: pnpm@${proposal.pnpmVersion} · ubicación: ~/.local/bin/pnpm`,
    "No se instalaron dependencias del proyecto ni se ejecutaron scripts.",
    "Ya puedes responder REPARAR DEPENDENCIAS; seguirá requiriendo una propuesta y una confirmación independiente.",
  ].join("\n");
}

async function applyConfirmedDependencyRepair(
  proposal: NonNullable<Awaited<ReturnType<typeof loadPendingDependencyRepair>>>,
): Promise<string> {
  const currentTarget = await interactiveSecurityTarget();
  if (currentTarget.repository !== proposal.repository || currentTarget.reference !== proposal.ref) {
    return [
      "DMsecurity 🛡️ · reparación cancelada",
      "El repositorio o la referencia configurados cambiaron desde la propuesta.",
      "Solicita REPARAR DEPENDENCIAS de nuevo para revisar el objetivo actual.",
    ].join("\n");
  }
  const [headCommit, referenceCommit] = await Promise.all([
    resolveGitCommit(proposal.repository, "HEAD"),
    resolveGitCommit(proposal.repository, proposal.ref),
  ]);
  if (headCommit !== proposal.commit || referenceCommit !== proposal.commit) {
    return [
      "DMsecurity 🛡️ · reparación cancelada",
      "La rama activa o la referencia revisada cambió desde la propuesta; no modificaré un objetivo distinto.",
      "Solicita REPARAR DEPENDENCIAS de nuevo para revisar el commit actual.",
    ].join("\n");
  }
  if (!await workingTreeIsClean(proposal.repository)) {
    return [
      "DMsecurity 🛡️ · reparación no aplicada",
      "El repositorio tiene cambios locales. Revísalos o guárdalos antes de modificar dependencias.",
      "La propuesta sigue pendiente mientras no caduque; usa CANCELAR para eliminarla.",
    ].join("\n");
  }
  if (await lockfileDigest(proposal.repository, proposal.lockfile) !== proposal.lockfileSha256) {
    return [
      "DMsecurity 🛡️ · reparación cancelada",
      "El lockfile cambió desde la revisión. Solicita una propuesta nueva para no reparar contenido distinto.",
    ].join("\n");
  }
  const packageManager = await packageManagerCommand(proposal.packageManager);
  if (!packageManager) {
    return [
      "DMsecurity 🛡️ · reparación no aplicada",
      `${proposal.packageManager} ya no está disponible para el servicio local.`,
      proposal.packageManager === "pnpm"
        ? "Responde INSTALAR PNPM para preparar una instalación limitada y confirmada."
        : "Instala o repara npm localmente y vuelve a solicitar REPARAR DEPENDENCIAS.",
    ].join("\n");
  }
  try {
    await execFile(packageManager, dependencyRepairArguments(proposal.packageManager), {
      cwd: proposal.repository,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    return [
      "DMsecurity 🛡️ · reparación no aplicada",
      `No se pudo completar la actualización segura con ${proposal.packageManager}.`,
      "Comprueba que el gestor esté instalado y revisa sus dependencias localmente; no se expone la salida del gestor por WhatsApp.",
    ].join("\n");
  }

  // Only the updated lockfile is rechecked against the local advisory DB. It
  // deliberately does not execute project test scripts received from a chat.
  useInstalledScannersForOnboarding();
  const verification = await scanOsv({
    snapshotDir: proposal.repository,
    lockfiles: [proposal.lockfile],
  });
  const vulnerabilities = verification.findings.length;
  await clearPendingDependencyRepair();
  return [
    "DMsecurity 🛡️ · reparación de dependencias terminada",
    `Repositorio: ${repositoryAlias(proposal.repository)} · lockfile: ${proposal.lockfile}`,
    `Verificación posterior: OSV ${verification.status} · vulnerabilidades detectadas: ${vulnerabilities}.`,
    vulnerabilities === 0 && verification.status === "ok"
      ? "La base local no detectó vulnerabilidades en el lockfile actualizado. Revisa git diff y ejecuta tus pruebas locales antes de hacer commit."
      : "Aún hay hallazgos o cobertura pendiente. Usa DETALLE y revisa git diff antes de hacer commit.",
    "DMsecurity no ejecuta scripts de prueba del repositorio desde WhatsApp.",
  ].join("\n");
}

async function dependencyRepairFromAdminChat(): Promise<string> {
  const review = await runAdminReview();
  const dependencyFindings = review.result.findings.filter((finding) => finding.type === "dependency");
  if (dependencyFindings.length === 0) {
    return [
      "DMsecurity 🛡️ · no hay una reparación automática propuesta",
      "La revisión no detectó dependencias vulnerables. Si la cobertura fue incompleta, restablece los escáneres o la base de OSV antes de continuar.",
    ].join("\n");
  }
  if (!await workingTreeIsClean(review.repository)) {
    return [
      "DMsecurity 🛡️ · reparación detenida",
      "El repositorio tiene cambios locales. No modificaré el lockfile hasta que el árbol de trabajo esté limpio.",
      "Puedes usar DETALLE para revisar los hallazgos sin cambiar archivos.",
    ].join("\n");
  }
  const repair = packageManagerForLockfiles(review.result.snapshot?.lockfiles ?? []);
  if (!repair) {
    return [
      "DMsecurity 🛡️ · reparación manual necesaria",
      "Sólo puedo preparar reparaciones seguras para package-lock.json (npm) o pnpm-lock.yaml (pnpm), y no hay un único lockfile compatible.",
      "Actualiza la dependencia afectada y su lockfile localmente; después responde REVISAR.",
    ].join("\n");
  }
  if (!await packageManagerAvailable(repair.packageManager)) {
    return [
      "DMsecurity 🛡️ · reparación no disponible",
      `${repair.packageManager} no está instalado o no está disponible para el servicio local.`,
      repair.packageManager === "pnpm"
        ? "Responde INSTALAR PNPM para recibir una propuesta limitada y confirmable."
        : "Instala o repara npm localmente y vuelve a solicitar REPARAR DEPENDENCIAS.",
    ].join("\n");
  }
  const commit = review.result.snapshot?.commit;
  if (!commit) throw new CliError("La revisión no produjo un commit verificable para la reparación.");
  const proposal = await createPendingDependencyRepair({
    repository: review.repository,
    ref: review.reference,
    commit,
    lockfile: repair.lockfile,
    lockfileSha256: await lockfileDigest(review.repository, repair.lockfile),
    packageManager: repair.packageManager,
  });
  return dependencyRepairProposalMessage(proposal);
}

/** Prepares a pnpm bootstrap based only on the configured repository metadata. */
async function pnpmInstallFromAdminChat(): Promise<string> {
  const target = await interactiveSecurityTarget();
  const version = await packageManagerVersionFromRepository(target.repository);
  if (!version) {
    return [
      "DMsecurity 🛡️ · instalación no disponible",
      "El package.json configurado no declara una versión estable de pnpm permitida.",
      "Declara packageManager como pnpm@x.y.z (opcionalmente con su integridad de Corepack) y vuelve a intentarlo.",
    ].join("\n");
  }
  if (await packageManagerAvailable("pnpm")) {
    return [
      "DMsecurity 🛡️ · pnpm ya está disponible",
      `El repositorio requiere pnpm@${version}. No se modificó tu equipo.`,
      "Responde REPARAR DEPENDENCIAS para preparar la actualización segura del lockfile.",
    ].join("\n");
  }
  const npm = await packageManagerCommand("npm");
  if (!npm) {
    return [
      "DMsecurity 🛡️ · instalación no disponible",
      "npm no está disponible en este equipo. No puedo instalar pnpm sin una instalación local funcional de Node.js/npm.",
    ].join("\n");
  }
  const proposal = await createPendingPnpmInstall({
    repository: target.repository,
    ref: target.reference,
    commit: await resolveGitCommit(target.repository, target.reference),
    packageJsonSha256: await lockfileDigest(target.repository, "package.json"),
    pnpmVersion: version,
  });
  return pnpmInstallProposalMessage(proposal);
}

async function secretRepairFromAdminChat(): Promise<string> {
  const review = await runAdminReview();
  const secrets = review.result.findings.filter((finding) => finding.type === "secret");
  if (secrets.length === 0) {
    return "DMsecurity 🛡️ · no se detectaron posibles secretos en la última revisión. Si la cobertura está incompleta, corrígela antes de confiar en este resultado.";
  }
  const locations = secrets.slice(0, 12).map((finding, index) => `${index + 1}. ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`} · ${finding.id}`);
  return redactSecrets([
    "DMsecurity 🛡️ · secretos: reparación guiada",
    `Se detectaron ${secrets.length} posible(s) secreto(s):`,
    ...locations,
    secrets.length > locations.length ? `… y ${secrets.length - locations.length} más; usa dmsecurity detailed-check localmente.` : "",
    "No puedo revocar una clave desde WhatsApp: entra al proveedor real (GitHub, AWS, Stripe, etc.), revócala y genera una nueva.",
    "Después reemplázala por una variable de entorno o gestor de secretos, elimina el valor del historial y responde REVISAR.",
  ].filter(Boolean).join("\n"));
}

/** Runs one long-lived, allowlisted local WhatsApp administrator conversation. */
async function runAdminChat(): Promise<number> {
  const lock = await acquireAdminChatLock();
  if (!lock) {
    throw new CliError("El chat de administrador ya está activo. Usa 'dmsecurity admin-chat stop' antes de iniciar otra sesión.");
  }
  let chat: Awaited<ReturnType<typeof openWhatsAppAdminChat>> | undefined;
  let interval: NodeJS.Timeout | undefined;
  try {
    const options = await whatsAppOptionsFromEnvironment();
    const connectedChat = await openWhatsAppAdminChat(options);
    chat = connectedChat;
    let latestReview: AnalysisResult | null = null;
    let latestTarget: { repository: string; reference: string } | null = null;
    let nextExpensiveActionAt = 0;
    let draining = false;
    const drainOutbox = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        await deliverPendingNotifications(connectedChat.notificationTransport());
      } catch {
        // Delivery failures stay queued with their safe status for a later retry.
      } finally {
        draining = false;
      }
    };
    const review = async (): Promise<{ result: AnalysisResult; repository: string; reference: string }> => {
      const completed = await runAdminReview();
      latestReview = completed.result;
      latestTarget = { repository: completed.repository, reference: completed.reference };
      return completed;
    };
    const send = async (message: string): Promise<void> => {
      await connectedChat.sendText(message);
    };
    const expensiveActionWait = (): string | null => {
      const remaining = nextExpensiveActionAt - Date.now();
      if (remaining <= 0) return null;
      return `DMsecurity 🛡️ · espera ${Math.ceil(remaining / 1000)} s antes de solicitar otra revisión. Esto protege el equipo contra ejecuciones repetidas.`;
    };
    const finishExpensiveAction = (): void => {
      nextExpensiveActionAt = Date.now() + 30_000;
    };

    interval = setInterval(() => { void drainOutbox(); }, 20_000);
    await send(`${adminChatMenu()}\n\nEl chat quedó activo para ${repositoryAlias((await interactiveSecurityTarget()).repository)}.`);
    await drainOutbox();
    let messageQueue = Promise.resolve();
    connectedChat.onMessage(async (message) => {
      messageQueue = messageQueue.catch(() => undefined).then(async () => {
      const command = parseAdminCommand(message.text);
      try {
        if (command.kind === "menu") return send(adminChatMenu());
        if (command.kind === "unknown") return send(unknownAdminCommandMessage());
        if (command.kind === "cancel") {
          await Promise.all([clearPendingDependencyRepair(), clearPendingPnpmInstall()]);
          return send("DMsecurity 🛡️ · se descartó cualquier acción pendiente. No se modificó el repositorio.");
        }
        if (command.kind === "review") {
          const wait = expensiveActionWait();
          if (wait) return send(wait);
          await send("DMsecurity 🛡️ · recibí REVISAR. Estoy analizando dependencias, secretos y cobertura…");
          try {
            const completed = await review();
            return send(adminReviewMessage(completed.result, repositoryAlias(completed.repository), completed.reference));
          } finally {
            finishExpensiveAction();
          }
        }
        if (command.kind === "details") {
          await send("DMsecurity 🛡️ · recibí DETALLE. Estoy preparando el resumen redactado…");
          const completed = latestReview && latestTarget
            ? { result: latestReview, repository: latestTarget.repository, reference: latestTarget.reference }
            : await review();
          return send(adminDetailMessage(completed.result));
        }
        if (command.kind === "repair_dependencies") {
          const wait = expensiveActionWait();
          if (wait) return send(wait);
          await send("DMsecurity 🛡️ · recibí REPARAR DEPENDENCIAS. Revisaré el repositorio y prepararé una propuesta segura…");
          try {
            return send(await dependencyRepairFromAdminChat());
          } finally {
            finishExpensiveAction();
          }
        }
        if (command.kind === "repair_secrets") {
          const wait = expensiveActionWait();
          if (wait) return send(wait);
          await send("DMsecurity 🛡️ · recibí REPARAR SECRETOS. Revisaré los hallazgos y prepararé la guía de rotación…");
          try {
            return send(await secretRepairFromAdminChat());
          } finally {
            finishExpensiveAction();
          }
        }
        if (command.kind === "install_pnpm") {
          await send("DMsecurity 🛡️ · recibí INSTALAR PNPM. Verificaré la versión fijada por el repositorio y prepararé una propuesta limitada…");
          return send(await pnpmInstallFromAdminChat());
        }
        if (command.kind === "confirm") {
          const [repairProposal, pnpmProposal] = await Promise.all([
            loadPendingDependencyRepair(),
            loadPendingPnpmInstall(),
          ]);
          if (repairProposal && repairProposal.token === command.token) {
            await send("DMsecurity 🛡️ · confirmación recibida. Aplicando únicamente la reparación propuesta y verificando el lockfile…");
            return send(await applyConfirmedDependencyRepair(repairProposal));
          }
          if (pnpmProposal && pnpmProposal.token === command.token) {
            await send("DMsecurity 🛡️ · confirmación recibida. Instalaré únicamente pnpm con la versión y las opciones mostradas…");
            return send(await applyConfirmedPnpmInstall(pnpmProposal));
          }
          return send("DMsecurity 🛡️ · no existe una propuesta válida con ese código. Solicita REPARAR DEPENDENCIAS o INSTALAR PNPM otra vez.");
        }
        return send(unknownAdminCommandMessage());
      } catch {
        return send("DMsecurity 🛡️ · no pude completar esa acción. El problema se registró sólo de forma local; usa MENU o revisa la terminal del servicio.");
      }
      });
      await messageQueue;
    });
    process.stdout.write("DMsecurity: chat de administrador activo. Sólo acepta mensajes directos del número configurado. Presiona Ctrl+C para detenerlo.\n");
    await connectedChat.waitUntilClosed();
    throw new CliError("El chat de administrador perdió la conexión con WhatsApp. Vuelve a vincularlo con dmsecurity --login si no se reconecta.");
  } finally {
    if (interval) clearInterval(interval);
    if (chat) await chat.close();
    await releaseAdminChatLock(lock);
  }
}

async function runAdminChatCommand(argv: string[]): Promise<number> {
  if (argv.length === 1) return runAdminChat();
  if (argv.length !== 2 || !["install", "stop"].includes(argv[1] ?? "")) {
    throw new CliError("Usa 'dmsecurity admin-chat', 'dmsecurity admin-chat install' o 'dmsecurity admin-chat stop'.");
  }
  if (argv[1] === "stop") {
    await disableAdminChatService();
    await clearAdminChatActive();
    process.stdout.write("Chat de administrador detenido y servicio local eliminado.\n");
    return 0;
  }
  const entrypoint = fileURLToPath(import.meta.url);
  const unit = await writeAdminChatUnit(entrypoint, process.execPath);
  try {
    await enableAdminChatService();
  } catch {
    throw new CliError(`El servicio se creó en ${unit}, pero systemd no pudo activarlo. Ejecuta 'systemctl --user daemon-reload && systemctl --user enable --now dmsecurity-admin-chat.service'.`);
  }
  process.stdout.write("Chat de administrador activado. Escribe MENU desde el número configurado para ver las acciones permitidas.\n");
  return 0;
}

function interactiveCommandArguments(value: string): string[] | null {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0] === "dmsecurity") parts.shift();
  return parts.length > 0 ? parts : null;
}

/** Shows a reference table and safely dispatches one typed DMsecurity command. */
async function runCommands(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(commandReference());
    return 0;
  }
  while (true) {
    process.stdout.write(commandReference());
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let input: string;
    try {
      input = (await terminal.question("Ingresa un comando o presiona 0 para regresar: ")).trim();
    } catch {
      return 0;
    } finally {
      terminal.close();
    }
    if (!input || input === "0") return 0;
    const argv = interactiveCommandArguments(input);
    if (!argv) {
      process.stdout.write("Ingresa un comando de la tabla o presiona 0 para regresar.\n");
      continue;
    }
    if (argv[0] === "comandos" || argv[0] === "--help" || argv[0] === "-h") {
      process.stdout.write("Ya estás en la vista de comandos. Elige otro comando o presiona 0.\n");
      continue;
    }
    const exitCode = await main(argv);
    if (exitCode !== 0) process.stdout.write("El comando terminó con un error. Revisa el mensaje anterior e inténtalo de nuevo.\n");
  }
}

/** One interactive setup: local settings, QR link, user timer and pre-commit hook. */
async function runOnboard(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError("onboard requiere una terminal interactiva.");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(setupBanner());
    const invalidSchedules = [];
    for (const entry of await listSchedules()) {
      try {
        await validateGitRepository(entry.repository);
      } catch {
        invalidSchedules.push(entry);
      }
    }
    if (invalidSchedules.length > 0 && enabled(await terminal.question(`¿Eliminar ${invalidSchedules.length} programación(es) inválida(s)? [S/n]: `), true)) {
      for (const entry of invalidSchedules) {
        await disableSchedule(entry.id);
        await removeSchedule(entry.id);
      }
      await reloadUserSystemd();
      process.stdout.write(setupSuccess("Programaciones inválidas eliminadas."));
    }
    process.stdout.write(setupStep(1, "Repositorio", "Selecciona un repositorio Git local y la referencia que se revisará."));
    const repositoryInput = (await terminal.question(`Repositorio a proteger [${process.cwd()}]: `)).trim() || process.cwd();
    const repository = await validateGitRepository(repositoryInput);
    const reference = (await terminal.question("Rama o referencia para revisiones periódicas [HEAD]: ")).trim() || "HEAD";
    await validateReference(repository, reference);
    process.stdout.write(setupSuccess(`Repositorio validado · referencia ${reference}`));
    await saveSecurityTarget(repository, reference);
    process.stdout.write(setupSuccess("Repositorio guardado para verificaciones rápidas y detalladas."));

    process.stdout.write(setupStep(2, "Alertas por WhatsApp", "Vincula una cuenta por QR; solo se enviarán resúmenes seguros."));
    const configureWhatsApp = enabled(await terminal.question("¿Configurar alertas por WhatsApp ahora? [S/n]: "), true);
    let activateAdminChat = false;
    if (configureWhatsApp) {
      const saved = await loadWhatsAppSettings();
      const current = saved ? ` [${saved.recipient}]` : "";
      const enteredRecipient = (await terminal.question(`Número destinatario con código de país y +${current}: `)).trim();
      if (enteredRecipient && !enteredRecipient.startsWith("+")) {
        throw new CliError("Escribe el número con código de país y + (por ejemplo +521...).");
      }
      const recipient = enteredRecipient || saved?.recipient;
      if (!recipient) throw new CliError("Se requiere un número destinatario para activar las alertas.");
      const settings = await saveWhatsAppSettings(recipient);
      process.stdout.write(setupSuccess(`Destinatario guardado localmente · ${settings.recipient}`));
      await loginWhatsApp();
      process.stdout.write(setupSuccess("WhatsApp vinculado."));
      activateAdminChat = enabled(await terminal.question("¿Activar el chat seguro de administrador por WhatsApp? [S/n]: "), true);
      if (activateAdminChat) {
        process.stdout.write(setupSuccess("El chat se activará después de enviar el resumen de la primera verificación."));
      }
    } else {
      process.stdout.write(setupWarning("Las alertas por WhatsApp permanecerán desactivadas."));
    }

    process.stdout.write(setupStep(3, "Automatización", "Crea revisiones periódicas y una protección opcional antes de cada commit."));
    let scheduledEntry: ScheduleEntry | undefined;
    const scheduleScan = enabled(await terminal.question("¿Crear y activar una revisión periódica? [S/n]: "), true);
    if (scheduleScan) {
      const every = (await terminal.question("Intervalo (por ejemplo 6h o 1d) [6h]: ")).trim() || "6h";
      const entry = await addSchedule({
        repository,
        ref: reference,
        every,
        notify: configureWhatsApp ? "whatsapp" : "none",
        on: defaultNotificationKinds(),
      });
      // A timer can run immediately when enabled. Keep it stopped until the
      // first alert has used the linked WhatsApp session by itself.
      await disableSchedule(entry.id);
      await writeScheduleUnits(entry, scheduledScript);
      scheduledEntry = entry;
      process.stdout.write(setupSuccess(`Revisión periódica preparada cada ${entry.every}; se activará después de la primera verificación.`));
    }

    const installPreCommit = enabled(await terminal.question("¿Instalar la protección pre-commit? [S/n]: "), true);
    if (installPreCommit) {
      const requestedMode = (await terminal.question("Modo del hook: block o warn [block]: ")).trim() || "block";
      if (requestedMode !== "block" && requestedMode !== "warn") throw new CliError("El modo del hook debe ser block o warn.");
      try {
        const hookPath = await installHook(repository, requestedMode, configureWhatsApp ? "whatsapp" : "none", "findings,incomplete");
        process.stdout.write(setupSuccess(`Protección pre-commit instalada · ${hookPath}`));
      } catch (error) {
        const message = error instanceof Error ? error.message : "No se pudo instalar la protección pre-commit.";
        process.stdout.write(setupWarning(`Protección pre-commit omitida · ${message}`));
      }
    }

    process.stdout.write(setupStep(4, "Primera verificación", "Se revisarán dependencias vulnerables y secretos expuestos."));
    useInstalledScannersForOnboarding();
    const firstScan = await executeScan({
      repo: repository,
      ref: reference,
      out: firstScanReportPath(),
      strictOffline: false,
    });
    process.stdout.write(setupResult(firstScan.result.status, firstScan.result.findings.length));
    process.stdout.write(`\n${terminalSummary(firstScan.result, firstScan.output)}`);
    if (configureWhatsApp) {
      const notification = await notifyAnalysis(firstScan.result, repository, reference, "onboarding", ["pass", "findings", "incomplete"]);
      process.stdout.write(notification.status === "sent"
        ? setupSuccess("Configuración completada y resumen de la primera verificación enviados por WhatsApp.")
        : setupWarning([
          `No se pudo enviar el resumen de configuración y primera verificación: ${notification.status}.`,
          notification.failure ? notificationFailureDetails(notification.failure) : "El mensaje quedó en cola y se reintentará en la siguiente revisión.",
        ].join(" ")));
    }
    if (activateAdminChat) {
      try {
        const unit = await writeAdminChatUnit(fileURLToPath(import.meta.url), process.execPath);
        await enableAdminChatService();
        process.stdout.write(setupSuccess(`Chat de administrador activado · ${unit}`));
      } catch {
        process.stdout.write(setupWarning("No se pudo activar el chat de administrador con systemd. Puedes intentar después: dmsecurity admin-chat install"));
      }
    }
    if (scheduledEntry) {
      try {
        await enableSchedule(scheduledEntry.id);
        process.stdout.write(setupSuccess(`Revisión periódica activada cada ${scheduledEntry.every}.`));
      } catch (error) {
        const message = error instanceof Error ? error.message : "No se pudo activar la revisión periódica.";
        process.stdout.write(setupWarning(`Programación creada, pero no activada · ${message}`));
      }
    }

    process.stdout.write(`\n${setupSuccess("Configuración terminada. Tu repositorio ya tiene una primera línea de defensa.")}`);
    return 0;
  } finally {
    terminal.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0) return 0;
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "comandos")) return await runCommands();
    if (argv.length === 1 && argv[0] === "--login") return await runWhatsApp(["whatsapp", "login"]);
    if (argv.length === 1 && argv[0] === "--logout") return await runWhatsApp(["whatsapp", "logout"]);
    if (argv.length === 1 && argv[0] === "detailed-check") return await runDetailedSecurityCheck();
    if (argv[0] === "admin-chat") return await runAdminChatCommand(argv);
    if (argv[0] === "scan") {
      const args = parseArguments(argv);
      const { result, output } = await executeScan(args);
      process.stdout.write(terminalSummary(result, output));
      if (args.notify) writeNotificationResult(await notifyAnalysis(result, args.repo, args.ref, "manual", args.notifyOn));
      return result.exitCode;
    }
    if (argv[0] === "check-staged") {
      const args = parseCheckStagedArguments(argv);
      const { result, output } = await executeCheckStaged(args);
      process.stdout.write(terminalSummary(result, output));
      if (args.notify) writeNotificationResult(await notifyAnalysis(result, args.repo, "INDEX", "pre_commit", args.notifyOn));
      return result.exitCode;
    }
    if (argv[0] === "onboard") return await runOnboard();
    if (argv[0] === "whatsapp") return await runWhatsApp(argv);
    if (argv[0] === "notify") return await runNotify(argv);
    if (argv[0] === "schedule") return await runSchedule(argv);
    if (argv[0] === "hook") return await runHook(argv);
    throw new CliError(`Unknown command.\n${usage()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected CLI failure.";
    process.stderr.write(`DMsecurity: ${message}\n`);
    return 2;
  }
}

function shouldOfferNextActionMenu(argv: string[]): boolean {
  if (argv.length === 0) return true;
  return argv.length === 1 && ["onboard", "--login", "--logout", "--help", "-h", "comandos", "detailed-check", "admin-chat"].includes(argv[0] ?? "");
}

/** Presents follow-up actions only to a person at an interactive terminal. */
async function offerNextActionMenu(): Promise<void> {
  const actions: Record<string, string[]> = {
    "1": ["--login"],
    "2": ["--logout"],
    "3": ["onboard"],
    "4": ["comandos"],
    "5": ["detailed-check"],
    "6": ["admin-chat", "install"],
  };

  while (true) {
    process.stdout.write(actionMenu());
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let choice: string;
    try {
      choice = (await terminal.question("Elige una opción [0]: ")).trim() || "0";
    } catch {
      return;
    } finally {
      terminal.close();
    }

    if (choice === "0") {
      process.stdout.write("Hasta pronto.\n");
      return;
    }
    const argv = actions[choice];
    if (!argv) {
      process.stdout.write("Opción inválida. Escribe un número del 0 al 6.\n");
      continue;
    }
    const exitCode = await main(argv);
    if (exitCode !== 0) process.stdout.write("La acción terminó con un error. Puedes intentar otra opción.\n");
  }
}

const invokedPath = process.argv[1];
const invokedAsProgram = invokedPath !== undefined
  && import.meta.url === pathToFileURL(realpathSync(invokedPath)).href;
if (invokedAsProgram) {
  const invocation = process.argv.slice(2);
  void main(invocation).then(async (exitCode) => {
    if (exitCode === 0 && process.stdin.isTTY && process.stdout.isTTY && shouldOfferNextActionMenu(invocation)) {
      await offerNextActionMenu();
    }
    process.exitCode = exitCode;
  });
}
