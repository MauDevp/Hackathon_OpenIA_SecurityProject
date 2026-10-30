import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import makeWASocket, { DisconnectReason, useMultiFileAuthState, type ConnectionState, type WASocket } from "@whiskeysockets/baileys";
import QRCode from "qrcode-terminal";

import type { NotificationFailureStage, NotificationTransport } from "./contracts.js";
import { formatWhatsAppMessage } from "./formatter.js";
import { loadWhatsAppSettings, normalizeWhatsAppRecipient } from "./settings.js";
import { notificationStateDir } from "./state.js";

const CONNECT_TIMEOUT_MS = 45_000;

/**
 * libsignal logs entire ratchet sessions with console.info/warn in a few code
 * paths, including message-session rotation. Filter only those exact upstream
 * calls for the whole lifecycle, before any socket can be created.
 */
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
console.info = (...values: unknown[]) => {
  if (values[0] !== "Closing session:") originalConsoleInfo(...values);
};
console.warn = (...values: unknown[]) => {
  if (values[0] !== "Session already closed") originalConsoleWarn(...values);
};

export class WhatsAppConfigurationError extends Error {
  readonly notificationFailure: { stage: NotificationFailureStage };

  constructor(message: string, stage: NotificationFailureStage = "configuration") {
    super(message);
    this.name = "WhatsAppConfigurationError";
    this.notificationFailure = { stage };
  }
}

export interface WhatsAppOptions {
  /** Destination phone in E.164 digits, for example 5215550000000. */
  recipient: string;
  /** Authentication directory; defaults to the user's private DMsecurity state. */
  authDir?: string;
  connectTimeoutMs?: number;
}

export interface WhatsAppLoginOptions {
  authDir?: string;
  connectTimeoutMs?: number;
  /** Makes the QR renderer testable without capturing stdout. */
  onQr?: (value: string) => void;
}

type SocketFactory = (options: Parameters<typeof makeWASocket>[0]) => WASocket;

type BaileysLogger = {
  level: string;
  child: (object: Record<string, unknown>) => BaileysLogger;
  trace: (object: unknown, message?: string) => void;
  debug: (object: unknown, message?: string) => void;
  info: (object: unknown, message?: string) => void;
  warn: (object: unknown, message?: string) => void;
  error: (object: unknown, message?: string) => void;
};

/** Baileys' protocol logs can include device metadata; the CLI reports only safe errors. */
const silentLogger: BaileysLogger = {
  level: "silent",
  child: () => silentLogger,
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface BaileysRuntime {
  makeSocket: SocketFactory;
  useAuthState: typeof useMultiFileAuthState;
  renderQr: (value: string) => void;
}

const runtime: BaileysRuntime = {
  makeSocket: makeWASocket,
  useAuthState: useMultiFileAuthState,
  renderQr(value) {
    QRCode.generate(value, { small: true });
  },
};

function authDirectory(input?: string): string {
  return input ?? join(notificationStateDir(), "whatsapp-auth");
}

function recipientPhone(recipient: string): string {
  try {
    return normalizeWhatsAppRecipient(recipient);
  } catch {
    throw new WhatsAppConfigurationError("The WhatsApp recipient must be a phone number in international E.164 digits.", "configuration");
  }
}

/** Lets WhatsApp resolve phone-number migrations and the correct current JID. */
async function resolveRecipient(socket: WASocket, recipient: string): Promise<string> {
  const phone = recipientPhone(recipient);
  // WhatsApp still uses a legacy `521` JID for some Mexican mobile accounts,
  // while people correctly enter their E.164 number as `+52` plus 10 digits.
  const candidates = phone.startsWith("52") && !phone.startsWith("521") && phone.length === 12
    ? [phone, `521${phone.slice(2)}`]
    : [phone];
  const ownId = socket.user?.id;
  const ownPhone = ownId?.split("@")[0]?.split(":")[0];
  if (ownPhone && candidates.includes(ownPhone)) return `${ownPhone}@s.whatsapp.net`;
  for (const candidate of candidates) {
    const matches = await socket.onWhatsApp(candidate);
    const destination = matches?.find((item) => item.exists);
    if (destination) return destination.jid;
  }
  throw new WhatsAppConfigurationError("The configured WhatsApp recipient could not be found.", "recipient");
}

/** Reads only the recipient; Baileys credentials come from the QR-linked local session. */
export async function whatsAppOptionsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<WhatsAppOptions> {
  const recipient = environment.DMSECURITY_WHATSAPP_RECIPIENT ?? (await loadWhatsAppSettings(environment))?.recipient;
  if (!recipient) {
    throw new WhatsAppConfigurationError(
      "Run 'guardia onboard' or set DMSECURITY_WHATSAPP_RECIPIENT to the international destination number, then run 'guardia whatsapp login' to link a phone by QR.",
      "configuration",
    );
  }
  return { recipient };
}

async function ensurePrivateAuthDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function protectAuthFiles(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isFile()) await chmod(join(path, entry.name), 0o600);
  }
}

function startSocket(
  auth: Awaited<ReturnType<typeof useMultiFileAuthState>>,
  runtimeOptions: BaileysRuntime,
  directory: string,
): { socket: WASocket; persistCredentials: () => Promise<void> } {
  const socket = runtimeOptions.makeSocket({
    auth: auth.state,
    browser: ["DMsecurity", "CLI", "0.1.0"],
    logger: silentLogger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  let writes = Promise.resolve();
  const persistCredentials = (): Promise<void> => {
    writes = writes.catch(() => undefined).then(async () => {
      await auth.saveCreds();
      await protectAuthFiles(directory);
    });
    return writes;
  };
  socket.ev.on("creds.update", () => {
    void persistCredentials().catch(() => undefined);
  });
  return { socket, persistCredentials };
}

function disconnectStatus(update: Partial<ConnectionState>): unknown {
  return (update.lastDisconnect?.error as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
}

function connectionMessage(update: Partial<ConnectionState>): string {
  const status = disconnectStatus(update);
  if (status === 401) return "WhatsApp session is no longer valid; run 'guardia whatsapp login' to link it again.";
  return "Could not connect to WhatsApp. Check the linked device and try again.";
}

function waitForOpen(
  socket: WASocket,
  timeoutMs: number,
  onQr?: (value: string) => void,
): Promise<"open" | "restart"> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result?: "open" | "restart", error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const timeout = setTimeout(
      () => finish(undefined, new WhatsAppConfigurationError("Timed out waiting for WhatsApp. Run 'guardia whatsapp login' and scan a current QR code.", "connection")),
      timeoutMs,
    );
    socket.ev.on("connection.update", (update) => {
      if (update.qr) onQr?.(update.qr);
      if (update.connection === "open") finish("open");
      if (update.connection === "close") {
        if (disconnectStatus(update) === DisconnectReason.restartRequired) finish("restart");
        else finish(undefined, new WhatsAppConfigurationError(connectionMessage(update), "connection"));
      }
    });
  });
}

async function closeSocket(socket: WASocket): Promise<void> {
  try {
    await socket.end(undefined);
  } catch {
    // Closing is best-effort. It must not turn a sent notification into a failure.
  }
}

async function connect(
  options: { authDir?: string; connectTimeoutMs?: number; onQr?: (value: string) => void },
  runtimeOptions: BaileysRuntime = runtime,
): Promise<{ socket: WASocket; close: () => Promise<void> }> {
  const directory = authDirectory(options.authDir);
  await ensurePrivateAuthDirectory(directory);
  const auth = await runtimeOptions.useAuthState(directory);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const connection = startSocket(auth, runtimeOptions, directory);
    try {
      const result = await waitForOpen(connection.socket, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, options.onQr);
      await connection.persistCredentials();
      if (result === "open") return { socket: connection.socket, close: () => closeSocket(connection.socket) };
      await closeSocket(connection.socket);
    } catch (error) {
      await closeSocket(connection.socket);
      if (error instanceof WhatsAppConfigurationError) throw error;
      throw new WhatsAppConfigurationError("Could not connect to WhatsApp. Check the linked device and try again.", "connection");
    }
  }
  throw new WhatsAppConfigurationError("WhatsApp requested repeated connection restarts. Run 'guardia whatsapp login' again.", "connection");
}

/** Opens a QR login session. The caller must scan it in WhatsApp > Linked devices. */
export async function loginWhatsApp(options: WhatsAppLoginOptions = {}): Promise<void> {
  let shown = false;
  const onQr = options.onQr ?? ((value: string) => {
    if (!shown) {
      process.stdout.write("Escanea este QR desde WhatsApp > Dispositivos vinculados > Vincular un dispositivo:\n");
      shown = true;
    }
    runtime.renderQr(value);
  });
  const connection = await connect({ ...options, onQr });
  await connection.close();
}

/** Removes only the local linked-device credentials; it leaves reports and the outbox untouched. */
export async function resetWhatsAppSession(options: Pick<WhatsAppLoginOptions, "authDir"> = {}): Promise<void> {
  await rm(authDirectory(options.authDir), { recursive: true, force: true });
}

/** Creates the local QR-linked WhatsApp Web transport, without any cloud API or token. */
export function createWhatsAppTransport(options: WhatsAppOptions): NotificationTransport {
  recipientPhone(options.recipient);
  return {
    async send(event) {
      const connection = await connect(options);
      try {
        const jid = await resolveRecipient(connection.socket, options.recipient);
        let message: Awaited<ReturnType<WASocket["sendMessage"]>>;
        try {
          message = await connection.socket.sendMessage(jid, { text: formatWhatsAppMessage(event) });
        } catch {
          throw new WhatsAppConfigurationError("WhatsApp did not confirm the message delivery.", "delivery");
        }
        const id = message?.key.id;
        return { providerMessageId: typeof id === "string" ? id.slice(0, 128) : "accepted" };
      } finally {
        await connection.close();
      }
    },
  };
}

/** Test seam: verifies connection and QR behavior without contacting WhatsApp. */
export async function loginWhatsAppForTesting(options: WhatsAppLoginOptions, runtimeOptions: BaileysRuntime): Promise<void> {
  const connection = await connect(options, runtimeOptions);
  await connection.close();
}
