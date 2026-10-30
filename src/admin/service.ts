import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const UNIT_NAME = "dmsecurity-admin-chat.service";

function systemdDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.DMSECURITY_SYSTEMD_USER_DIR
    ?? join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "")}"`;
}

function servicePath(nodeBinary: string, environment: NodeJS.ProcessEnv): string {
  const pnpmHome = environment.PNPM_HOME ?? join(homedir(), ".local", "share", "pnpm");
  const localBin = join(homedir(), ".local", "bin");
  return `${dirname(nodeBinary)}:${localBin}:${pnpmHome}:/usr/local/bin:/usr/bin:/bin`;
}

export function adminChatUnitPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(systemdDirectory(environment), UNIT_NAME);
}

export async function writeAdminChatUnit(entrypoint: string, nodeBinary: string, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const directory = systemdDirectory(environment);
  const unitPath = adminChatUnitPath(environment);
  const body = [
    "[Unit]",
    "Description=DMsecurity secure WhatsApp administrator chat",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `Environment=DMSECURITY_NODE_BIN=${systemdQuote(nodeBinary)}`,
    `Environment=PATH=${systemdQuote(servicePath(nodeBinary, environment))}`,
    `ExecStart=${systemdQuote(nodeBinary)} ${systemdQuote(entrypoint)} admin-chat`,
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(unitPath, body, { encoding: "utf8", mode: 0o600 });
  return unitPath;
}

export async function enableAdminChatService(): Promise<void> {
  await execFile("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  await execFile("systemctl", ["--user", "enable", "--now", UNIT_NAME], { encoding: "utf8" });
}

export async function disableAdminChatService(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await execFile("systemctl", ["--user", "disable", "--now", UNIT_NAME], { encoding: "utf8" });
  } catch {
    // Deleting the local unit remains useful when systemd is unavailable.
  }
  await rm(adminChatUnitPath(environment), { force: true });
  try {
    await execFile("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  } catch {
    // The next user-systemd reload will observe the removal.
  }
}
