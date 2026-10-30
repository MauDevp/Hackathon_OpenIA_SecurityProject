#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scanAll } from "../adapters/index.js";
import type { AnalysisResult, ScanAll } from "../contracts.js";
import { orchestrate, snapshotFailure } from "../core/orchestrator.js";
import { type GuardiaReport, serializeReport, terminalSummary } from "../core/report.js";
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
  resetWhatsAppSession,
  whatsAppOptionsFromEnvironment,
} from "../notifications/whatsapp.js";
import { loadWhatsAppSettings, saveWhatsAppSettings } from "../notifications/settings.js";
import { notificationStateDir } from "../notifications/state.js";
import { addSchedule, listSchedules, removeSchedule, type ScheduleEntry, writeScheduleUnits } from "../schedule.js";
import { setupBanner, setupResult, setupStep, setupSuccess, setupWarning } from "./presentation.js";

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
    "Usage:",
    "  guardia scan --repo <path> --ref <git-ref> --out <report.json> [--strict-offline] [--notify whatsapp] [--notify-on pass,findings,incomplete]",
    "  guardia check-staged --repo <path> --out <report.json> [--strict-offline] [--notify whatsapp] [--notify-on pass,findings,incomplete]",
    "  guardia onboard",
    "  dmsecurity --login | --logout",
    "  guardia whatsapp login | reset | logout",
    "  guardia notify --report <report.json> [--repo-alias <name>] [--ref <ref>] [--trigger scheduled|pre_commit|manual]",
    "  guardia schedule add --repo <path> --ref <git-ref> --every <30m|6h|1d> --notify <whatsapp|none> [--on findings,incomplete]",
    "  guardia schedule list | remove --id <id>",
    "  guardia hook install --repo <path> [--mode warn|block] [--notify none|whatsapp] [--on pass,findings,incomplete]",
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
    await resetWhatsAppSession();
    process.stdout.write("Sesión local de WhatsApp cerrada. Elimina también el dispositivo DMsecurity desde WhatsApp en el celular.\n");
    return 0;
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

    process.stdout.write(setupStep(2, "Alertas por WhatsApp", "Vincula una cuenta por QR; solo se enviarán resúmenes seguros."));
    const configureWhatsApp = enabled(await terminal.question("¿Configurar alertas por WhatsApp ahora? [S/n]: "), true);
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
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    if (argv.length === 1 && argv[0] === "--login") return await runWhatsApp(["whatsapp", "login"]);
    if (argv.length === 1 && argv[0] === "--logout") return await runWhatsApp(["whatsapp", "logout"]);
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
    process.stderr.write(`guardia: ${message}\n`);
    return 2;
  }
}

function shouldOfferNextActionMenu(argv: string[]): boolean {
  if (argv.length === 0) return true;
  return argv.length === 1 && ["onboard", "--login", "--logout", "--help", "-h"].includes(argv[0] ?? "");
}

/** Presents follow-up actions only to a person at an interactive terminal. */
async function offerNextActionMenu(): Promise<void> {
  const actions: Record<string, string[]> = {
    "1": ["--login"],
    "2": ["--logout"],
    "3": ["onboard"],
    "4": ["--help"],
  };

  while (true) {
    process.stdout.write([
      "",
      "¿Qué deseas hacer ahora?",
      "  1. dmsecurity --login",
      "  2. dmsecurity --logout",
      "  3. dmsecurity onboard",
      "  4. dmsecurity --help",
      "  5. Salir",
    ].join("\n") + "\n");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let choice: string;
    try {
      choice = (await terminal.question("Elige una opción [5]: ")).trim() || "5";
    } catch {
      return;
    } finally {
      terminal.close();
    }

    if (choice === "5") {
      process.stdout.write("Hasta pronto.\n");
      return;
    }
    const argv = actions[choice];
    if (!argv) {
      process.stdout.write("Opción inválida. Escribe un número del 1 al 5.\n");
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
