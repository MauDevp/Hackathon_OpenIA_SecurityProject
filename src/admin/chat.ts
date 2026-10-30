import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { AnalysisResult, Finding, ScannerResult } from "../contracts.js";
import { redactSecrets } from "../core/report.js";
import { notificationStateDir } from "../notifications/state.js";

export type AdminCommandKind = "menu" | "review" | "details" | "repair_dependencies" | "repair_secrets" | "install_pnpm" | "confirm" | "cancel" | "unknown";

export interface AdminCommand {
  kind: AdminCommandKind;
  token?: string;
}

export type SupportedPackageManager = "npm" | "pnpm";

/** A persisted proposal contains intent only; executable arguments are derived in code. */
export interface PendingDependencyRepair {
  version: 1;
  kind: "dependency_repair";
  token: string;
  repository: string;
  ref: string;
  /** Exact scanned Git commit; a moving branch name is never enough to repair. */
  commit: string;
  lockfile: string;
  /** Digest of the exact lockfile that was reviewed before asking confirmation. */
  lockfileSha256: string;
  packageManager: SupportedPackageManager;
  createdAt: string;
  expiresAt: string;
}

/**
 * A deliberately narrow bootstrap action. It cannot select a package, a
 * registry, a destination, or arbitrary npm arguments from WhatsApp.
 */
export interface PendingPnpmInstall {
  version: 1;
  kind: "pnpm_install";
  token: string;
  repository: string;
  ref: string;
  commit: string;
  packageJsonSha256: string;
  pnpmVersion: string;
  createdAt: string;
  expiresAt: string;
}

interface ActiveAdminChat {
  version: 1;
  instanceId: string;
  pid: number;
  startedAt: string;
}

export interface AdminChatLock {
  instanceId: string;
}

const PROPOSAL_LIFETIME_MS = 10 * 60 * 1000;

function adminDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return join(notificationStateDir(environment), "admin-chat");
}

function pendingRepairPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(adminDirectory(environment), "pending-repair.json");
}

function pendingPnpmInstallPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(adminDirectory(environment), "pending-pnpm-install.json");
}

function activeChatPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(adminDirectory(environment), "active.json");
}

function normalizedCommand(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleUpperCase("es-MX");
}

/** Parses a deliberately small command language. It never accepts shell syntax. */
export function parseAdminCommand(value: string): AdminCommand {
  const input = normalizedCommand(value);
  if (["MENU", "AYUDA", "HOLA", "INICIO", "INICIAR"].includes(input)) return { kind: "menu" };
  // The chat presents numbered choices, so accept either the short number or
  // the visible "3. REPARAR DEPENDENCIAS" label without broadening the allowlist.
  if (input === "1" || input === "REVISAR" || input === "1. REVISAR") return { kind: "review" };
  if (input === "2" || input === "DETALLE" || input === "2. DETALLE") return { kind: "details" };
  if (input === "3" || input === "REPARAR DEPENDENCIAS" || input === "3. REPARAR DEPENDENCIAS") return { kind: "repair_dependencies" };
  if (input === "4" || input === "REPARAR SECRETOS" || input === "4. REPARAR SECRETOS") return { kind: "repair_secrets" };
  if (input === "5" || input === "CANCELAR" || input === "5. CANCELAR") return { kind: "cancel" };
  if (input === "6" || input === "INSTALAR PNPM" || input === "6. INSTALAR PNPM") return { kind: "install_pnpm" };
  const confirmation = /^CONFIRMAR ([A-F0-9]{12})$/.exec(input);
  if (confirmation?.[1]) return { kind: "confirm", token: confirmation[1] };
  return { kind: "unknown" };
}

export function adminChatMenu(): string {
  return [
    "DMsecurity 🛡️ · administrador seguro",
    "¿Qué quieres ejecutar? Responde con una opción:",
    "1. REVISAR — analiza el repositorio configurado.",
    "2. DETALLE — muestra hallazgos y correcciones seguras.",
    "3. REPARAR DEPENDENCIAS — prepara una actualización sin scripts.",
    "4. REPARAR SECRETOS — guía la rotación y corrección manual.",
    "5. CANCELAR — elimina una reparación pendiente.",
    "6. INSTALAR PNPM — instala sólo la versión fijada por el repositorio.",
    "Para aplicar una propuesta usa CONFIRMAR <código>.",
    "Sólo este número administrador puede usar estas acciones.",
  ].join("\n");
}

export function unknownAdminCommandMessage(): string {
  return [
    "DMsecurity 🛡️ · no reconocí esa acción.",
    "Usa MENU para ver: REVISAR, DETALLE, REPARAR DEPENDENCIAS, REPARAR SECRETOS, INSTALAR PNPM o CANCELAR.",
    "Nunca ejecuto comandos de shell enviados por WhatsApp.",
  ].join("\n");
}

function findingCounts(result: AnalysisResult): { dependencies: number; secrets: number } {
  return {
    dependencies: result.findings.filter((finding) => finding.type === "dependency").length,
    secrets: result.findings.filter((finding) => finding.type === "secret").length,
  };
}

function scannerSummary(scanners: ScannerResult[]): string {
  return scanners.map((scanner) => `${scanner.scanner}: ${scanner.status}`).join(" · ");
}

/** Redacted short result suitable for a WhatsApp conversation. */
export function adminReviewMessage(result: AnalysisResult, repository: string, ref: string): string {
  const counts = findingCounts(result);
  const resultLine = result.status === "PASS"
    ? "Resultado: PASS. No se detectaron hallazgos con la cobertura disponible."
    : result.status === "INCOMPLETE"
      ? "Resultado: INCOMPLETO. No confíes en un resultado limpio hasta recuperar la cobertura."
      : `Resultado: se detectaron ${result.findings.length} hallazgo(s).`;
  return redactSecrets([
    "DMsecurity 🛡️ · revisión terminada",
    `Repositorio: ${repository} · referencia: ${ref}`,
    resultLine,
    `Dependencias vulnerables: ${counts.dependencies} · posibles secretos: ${counts.secrets}.`,
    `Cobertura: ${scannerSummary(result.scanners)}.`,
    "Responde DETALLE para ver ubicaciones redactadas y las acciones recomendadas.",
  ].join("\n"));
}

function shortFinding(finding: Finding, index: number): string {
  const location = `${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`;
  const label = finding.type === "dependency" ? "Dependencia" : "Posible secreto";
  return `${index + 1}. ${label} · ${finding.id}\n   Ubicación: ${location}\n   ${finding.summary}`;
}

/** Detail remains redacted and bounded so a chat cannot become a report exfiltration channel. */
export function adminDetailMessage(result: AnalysisResult): string {
  const maximum = 12;
  const lines = ["DMsecurity 🛡️ · detalle de la revisión"];
  if (result.findings.length === 0) {
    lines.push("No se detectaron vulnerabilidades ni secretos con la cobertura disponible.");
  } else {
    for (const [index, finding] of result.findings.slice(0, maximum).entries()) {
      lines.push(shortFinding(finding, index));
    }
    if (result.findings.length > maximum) lines.push(`Se ocultaron ${result.findings.length - maximum} hallazgo(s) adicionales; consulta dmsecurity detailed-check localmente para la lista completa.`);
  }
  const incomplete = result.scanners.filter((scanner) => scanner.status !== "ok");
  if (incomplete.length > 0) lines.push(`Cobertura pendiente: ${incomplete.map((scanner) => scanner.scanner).join(", ")}.`);
  lines.push("Corrección: actualiza dependencias sin forzar versiones; para secretos, revoca/rota en el proveedor, reemplaza por variables de entorno y limpia el historial antes de continuar.");
  return redactSecrets(lines.join("\n"));
}

export function packageManagerForLockfiles(lockfiles: string[]): { packageManager: SupportedPackageManager; lockfile: string } | null {
  const npm = lockfiles.filter((file) => file.endsWith("package-lock.json") || file.endsWith("npm-shrinkwrap.json"));
  const pnpm = lockfiles.filter((file) => file.endsWith("pnpm-lock.yaml"));
  // A package-manager repair can affect its workspace. Do not claim a single
  // file will change when a repository has multiple compatible lockfiles.
  if (npm.length === 1 && pnpm.length === 0) return { packageManager: "npm", lockfile: npm[0] as string };
  if (pnpm.length === 1 && npm.length === 0) return { packageManager: "pnpm", lockfile: pnpm[0] as string };
  return null;
}

/** Fixed safe arguments; no WhatsApp text ever reaches an executable argument. */
export function dependencyRepairArguments(packageManager: SupportedPackageManager): string[] {
  if (packageManager === "npm") return ["audit", "fix", "--package-lock-only", "--ignore-scripts"];
  return ["audit", "--fix", "--ignore-scripts"];
}

/**
 * Only accepts a stable pnpm version declared by packageManager. The optional
 * Corepack sha512 suffix is metadata, not an npm argument.
 */
export function pnpmVersionFromPackageManager(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha512\.[a-f0-9]+)?$/i.exec(value.trim());
  return match?.[1] ?? null;
}

export async function createPendingDependencyRepair(
  input: Omit<PendingDependencyRepair, "version" | "kind" | "token" | "createdAt" | "expiresAt">,
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<PendingDependencyRepair> {
  const proposal: PendingDependencyRepair = {
    version: 1,
    kind: "dependency_repair",
    token: randomBytes(6).toString("hex").toUpperCase(),
    ...input,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PROPOSAL_LIFETIME_MS).toISOString(),
  };
  const destination = pendingRepairPath(environment);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(proposal)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, destination);
  return proposal;
}

function isPendingDependencyRepair(value: unknown): value is PendingDependencyRepair {
  if (!value || typeof value !== "object") return false;
  const proposal = value as Partial<PendingDependencyRepair>;
  return proposal.version === 1
    && proposal.kind === "dependency_repair"
    && typeof proposal.token === "string" && /^[A-F0-9]{12}$/.test(proposal.token)
    && typeof proposal.repository === "string"
    && typeof proposal.ref === "string"
    && typeof proposal.commit === "string" && /^[0-9a-f]{40,64}$/.test(proposal.commit)
    && typeof proposal.lockfile === "string"
    && typeof proposal.lockfileSha256 === "string" && /^[0-9a-f]{64}$/.test(proposal.lockfileSha256)
    && (proposal.packageManager === "npm" || proposal.packageManager === "pnpm")
    && typeof proposal.createdAt === "string"
    && typeof proposal.expiresAt === "string";
}

export async function loadPendingDependencyRepair(
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<PendingDependencyRepair | null> {
  const destination = pendingRepairPath(environment);
  try {
    const parsed: unknown = JSON.parse(await readFile(destination, "utf8"));
    if (!isPendingDependencyRepair(parsed) || Date.parse(parsed.expiresAt) <= now.getTime()) {
      await rm(destination, { force: true });
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPendingDependencyRepair(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(pendingRepairPath(environment), { force: true });
}

export async function createPendingPnpmInstall(
  input: Omit<PendingPnpmInstall, "version" | "kind" | "token" | "createdAt" | "expiresAt">,
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<PendingPnpmInstall> {
  const proposal: PendingPnpmInstall = {
    version: 1,
    kind: "pnpm_install",
    token: randomBytes(6).toString("hex").toUpperCase(),
    ...input,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PROPOSAL_LIFETIME_MS).toISOString(),
  };
  const destination = pendingPnpmInstallPath(environment);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(proposal)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, destination);
  return proposal;
}

function isPendingPnpmInstall(value: unknown): value is PendingPnpmInstall {
  if (!value || typeof value !== "object") return false;
  const proposal = value as Partial<PendingPnpmInstall>;
  return proposal.version === 1
    && proposal.kind === "pnpm_install"
    && typeof proposal.token === "string" && /^[A-F0-9]{12}$/.test(proposal.token)
    && typeof proposal.repository === "string"
    && typeof proposal.ref === "string"
    && typeof proposal.commit === "string" && /^[0-9a-f]{40,64}$/.test(proposal.commit)
    && typeof proposal.packageJsonSha256 === "string" && /^[0-9a-f]{64}$/.test(proposal.packageJsonSha256)
    && typeof proposal.pnpmVersion === "string" && /^\d+\.\d+\.\d+$/.test(proposal.pnpmVersion)
    && typeof proposal.createdAt === "string"
    && typeof proposal.expiresAt === "string";
}

export async function loadPendingPnpmInstall(
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<PendingPnpmInstall | null> {
  const destination = pendingPnpmInstallPath(environment);
  try {
    const parsed: unknown = JSON.parse(await readFile(destination, "utf8"));
    if (!isPendingPnpmInstall(parsed) || Date.parse(parsed.expiresAt) <= now.getTime()) {
      await rm(destination, { force: true });
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPendingPnpmInstall(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(pendingPnpmInstallPath(environment), { force: true });
}

export function dependencyRepairProposalMessage(proposal: PendingDependencyRepair): string {
  const command = `${proposal.packageManager} ${dependencyRepairArguments(proposal.packageManager).join(" ")}`;
  return [
    "DMsecurity 🛡️ · propuesta de reparación",
    `Repositorio: ${basename(proposal.repository) || "repositorio configurado"} · commit: ${proposal.commit.slice(0, 7)} · lockfile: ${proposal.lockfile}`,
    `Se ejecutará únicamente: ${command}`,
    "No se ejecutarán scripts del proyecto, no se hará --force y no se hará commit.",
    "La reparación dejará cambios locales para que los revises con git diff.",
    `Si estás de acuerdo responde: CONFIRMAR ${proposal.token}`,
    "El código caduca en 10 minutos. Responde CANCELAR para descartarlo.",
  ].join("\n");
}

export function pnpmInstallProposalMessage(proposal: PendingPnpmInstall): string {
  return [
    "DMsecurity 🛡️ · propuesta para instalar PNPM",
    `Repositorio: ${basename(proposal.repository) || "repositorio configurado"} · commit: ${proposal.commit.slice(0, 7)}`,
    `Se instalará únicamente: pnpm@${proposal.pnpmVersion} en ~/.local/bin`,
    "Origen: registro oficial de npm. No se ejecutarán scripts, no se instalarán dependencias del proyecto y no se modificará el repositorio.",
    `Si estás de acuerdo responde: CONFIRMAR ${proposal.token}`,
    "El código caduca en 10 minutos. Responde CANCELAR para descartarlo.",
  ].join("\n");
}

/** Atomically acquires the single local socket lease. Returns null if owned. */
export async function acquireAdminChatLock(environment: NodeJS.ProcessEnv = process.env): Promise<AdminChatLock | null> {
  const destination = activeChatPath(environment);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const instanceId = randomUUID();
    const marker: ActiveAdminChat = { version: 1, instanceId, pid: process.pid, startedAt: new Date().toISOString() };
    try {
      await writeFile(destination, `${JSON.stringify(marker)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { instanceId };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isAdminChatActive(environment)) return null;
      await rm(destination, { force: true });
    }
  }
  return null;
}

/** Stale markers are removed so normal notifications can recover after a crash. */
export async function isAdminChatActive(environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const destination = activeChatPath(environment);
  try {
    const parsed: unknown = JSON.parse(await readFile(destination, "utf8"));
    const marker = parsed as Partial<ActiveAdminChat>;
    if (marker.version !== 1 || typeof marker.instanceId !== "string" || typeof marker.pid !== "number" || marker.pid <= 0) throw new Error("invalid marker");
    try {
      process.kill(marker.pid, 0);
      return true;
    } catch {
      await rm(destination, { force: true });
      return false;
    }
  } catch {
    return false;
  }
}

export async function clearAdminChatActive(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(activeChatPath(environment), { force: true });
}

/** Releases a lease only if this process still owns the current marker. */
export async function releaseAdminChatLock(lock: AdminChatLock, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const destination = activeChatPath(environment);
  try {
    const marker: unknown = JSON.parse(await readFile(destination, "utf8"));
    if (typeof marker === "object" && marker !== null && (marker as Partial<ActiveAdminChat>).instanceId === lock.instanceId) {
      await rm(destination, { force: true });
    }
  } catch {
    // A stale or missing marker is already safe to ignore during shutdown.
  }
}
