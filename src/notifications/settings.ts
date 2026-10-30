import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface WhatsAppSettings {
  version: 1;
  /** E.164 digits only; it is private configuration, not a credential. */
  recipient: string;
}

/** Last repository selected in onboarding, used by the interactive checks. */
export interface SecurityTargetSettings {
  version: 1;
  repository: string;
  ref: string;
}

function configurationDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.DMSECURITY_CONFIG_DIR
    ?? join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "dmsecurity");
}

export function whatsappSettingsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(configurationDirectory(environment), "whatsapp.json");
}

export function securityTargetSettingsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(configurationDirectory(environment), "target.json");
}

export function normalizeWhatsAppRecipient(value: string): string {
  const normalized = value.replace(/[\s()+-]/g, "");
  if (!/^\d{8,15}$/.test(normalized)) {
    throw new Error("The WhatsApp recipient must be a phone number in international E.164 digits.");
  }
  return normalized;
}

function isSettings(value: unknown): value is WhatsAppSettings {
  return Boolean(value)
    && typeof value === "object"
    && (value as Partial<WhatsAppSettings>).version === 1
    && typeof (value as Partial<WhatsAppSettings>).recipient === "string";
}

function isSecurityTargetSettings(value: unknown): value is SecurityTargetSettings {
  return Boolean(value)
    && typeof value === "object"
    && (value as Partial<SecurityTargetSettings>).version === 1
    && typeof (value as Partial<SecurityTargetSettings>).repository === "string"
    && typeof (value as Partial<SecurityTargetSettings>).ref === "string";
}

export async function loadWhatsAppSettings(environment: NodeJS.ProcessEnv = process.env): Promise<WhatsAppSettings | null> {
  try {
    const value: unknown = JSON.parse(await readFile(whatsappSettingsPath(environment), "utf8"));
    if (!isSettings(value)) return null;
    return { version: 1, recipient: normalizeWhatsAppRecipient(value.recipient) };
  } catch {
    return null;
  }
}

/** Reads the last local Git target without exposing it through notifications. */
export async function loadSecurityTarget(environment: NodeJS.ProcessEnv = process.env): Promise<SecurityTargetSettings | null> {
  try {
    const value: unknown = JSON.parse(await readFile(securityTargetSettingsPath(environment), "utf8"));
    if (!isSecurityTargetSettings(value) || !value.repository || !value.ref) return null;
    return { version: 1, repository: value.repository, ref: value.ref };
  } catch {
    return null;
  }
}

/** Stores only the selected destination outside the repository with private permissions. */
export async function saveWhatsAppSettings(recipient: string, environment: NodeJS.ProcessEnv = process.env): Promise<WhatsAppSettings> {
  const settings: WhatsAppSettings = { version: 1, recipient: normalizeWhatsAppRecipient(recipient) };
  const destination = whatsappSettingsPath(environment);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, destination);
  return settings;
}

/** Persists the chosen local repository for the detailed menu check. */
export async function saveSecurityTarget(
  repository: string,
  ref: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SecurityTargetSettings> {
  if (!repository || !ref) throw new Error("The security target requires a repository and ref.");
  const settings: SecurityTargetSettings = { version: 1, repository, ref };
  const destination = securityTargetSettingsPath(environment);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, destination);
  return settings;
}
