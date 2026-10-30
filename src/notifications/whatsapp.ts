import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type ConnectionState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
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

export interface IncomingAdminMessage {
  /** Baileys message identifier, used only to prevent repeated processing. */
  id: string;
  /** Resolved direct JID of the configured administrator. */
  sender: string;
  /** Plain text only. Media and document payloads are intentionally ignored. */
  text: string;
}

export interface WhatsAppAdminChat {
  /** The exact direct WhatsApp JID that is authorized for this session. */
  readonly administratorJid: string;
  /** Sends an already-redacted response through the existing connected socket. */
  sendText(text: string): Promise<void>;
  /** Uses this same socket to drain ordinary alert notifications without a second login. */
  notificationTransport(): NotificationTransport;
  /** Incoming messages are filtered to direct messages from administratorJid. */
  onMessage(handler: (message: IncomingAdminMessage) => Promise<void>): void;
  /** Resolves only when the WhatsApp connection closes unexpectedly. */
  waitUntilClosed(): Promise<void>;
  close(): Promise<void>;
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
      "Run 'dmsecurity onboard' or set DMSECURITY_WHATSAPP_RECIPIENT to the international destination number, then run 'dmsecurity --login' to link a phone by QR.",
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
  if (status === 401) return "WhatsApp session is no longer valid; run 'dmsecurity --login' to link it again.";
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
      () => finish(undefined, new WhatsAppConfigurationError("Timed out waiting for WhatsApp. Run 'dmsecurity --login' and scan a current QR code.", "connection")),
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

function safeTextFromMessage(message: WAMessage): string | null {
  const content = message.message;
  if (!content) return null;
  const nested = content.ephemeralMessage?.message
    ?? content.viewOnceMessage?.message
    ?? content.viewOnceMessageV2?.message
    ?? content.viewOnceMessageV2Extension?.message;
  const text = content.conversation ?? content.extendedTextMessage?.text ?? nested?.conversation ?? nested?.extendedTextMessage?.text;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  // Limit work and prevent a chat input from becoming a general transport.
  return trimmed.length > 0 && trimmed.length <= 160 ? trimmed : null;
}

/** Pure authorization gate: never accept groups, self-messages or other contacts. */
export function isAuthorizedAdminMessage(
  message: Pick<WAMessage, "key">,
  administratorJid: string,
  options: { allowOwnMessages?: boolean; sentByDmsecurity?: ReadonlySet<string> } = {},
): boolean {
  const remoteJid = message.key.remoteJid;
  const alternateJid = message.key.remoteJidAlt;
  const isDirectConversation = typeof remoteJid === "string"
    && (remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@lid"));
  const isAdministrator = isDirectConversation
    // Baileys can expose a LID as remoteJid and the phone JID as remoteJidAlt.
    // Match either value only to the pre-resolved configured administrator.
    && (remoteJid === administratorJid || alternateJid === administratorJid);
  if (!isAdministrator) return false;
  if (message.key.fromMe !== true) return true;
  // When the administrator deliberately uses the same WhatsApp account that
  // scanned the QR, their command arrives as fromMe. Accept that one case,
  // while refusing every message that this DMsecurity process just sent.
  const id = message.key.id;
  return options.allowOwnMessages === true
    && typeof id === "string"
    && !options.sentByDmsecurity?.has(id);
}

async function sendText(socket: WASocket, jid: string, text: string): Promise<string> {
  try {
    const message = await socket.sendMessage(jid, { text });
    const id = message?.key.id;
    if (!id) throw new Error("missing message id");
    return id;
  } catch {
    throw new WhatsAppConfigurationError("WhatsApp did not confirm the message delivery.", "delivery");
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
  throw new WhatsAppConfigurationError("WhatsApp requested repeated connection restarts. Run 'dmsecurity --login' again.", "connection");
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
        await sendText(connection.socket, jid, formatWhatsAppMessage(event));
        return { providerMessageId: "accepted" };
      } finally {
        await connection.close();
      }
    },
  };
}

/**
 * Opens a long-lived, local WhatsApp Web socket for the secure administrator
 * chat. Ordinary alerts can share this socket, avoiding concurrent linked
 * device sessions. This function does not parse or execute commands.
 */
export async function openWhatsAppAdminChat(options: WhatsAppOptions): Promise<WhatsAppAdminChat> {
  const connection = await connect(options);
  let administratorJid: string;
  try {
    administratorJid = await resolveRecipient(connection.socket, options.recipient);
  } catch (error) {
    await connection.close();
    throw error;
  }
  const ownPhone = connection.socket.user?.id?.split("@")[0]?.split(":")[0];
  const allowOwnMessages = ownPhone !== undefined && administratorJid === `${ownPhone}@s.whatsapp.net`;
  let handler: ((message: IncomingAdminMessage) => Promise<void>) | undefined;
  const seen = new Set<string>();
  const sentByDmsecurity = new Set<string>();
  const rememberSent = (id: string): void => {
    sentByDmsecurity.add(id);
    if (sentByDmsecurity.size > 256) sentByDmsecurity.delete(sentByDmsecurity.values().next().value as string);
  };
  let closedResolve: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  connection.socket.ev.on("connection.update", (update) => {
    if (update.connection === "close") closedResolve?.();
  });
  connection.socket.ev.on("messages.upsert", (update) => {
    if (update.type !== "notify") return;
    for (const message of update.messages) {
      if (!isAuthorizedAdminMessage(message, administratorJid, { allowOwnMessages, sentByDmsecurity })) continue;
      const id = message.key.id;
      const text = safeTextFromMessage(message);
      if (!id || !text || seen.has(id)) continue;
      seen.add(id);
      if (seen.size > 256) seen.delete(seen.values().next().value as string);
      const currentHandler = handler;
      if (currentHandler) {
        void currentHandler({ id, sender: administratorJid, text }).catch(() => undefined);
      }
    }
  });

  return {
    administratorJid,
    async sendText(text) {
      rememberSent(await sendText(connection.socket, administratorJid, text));
    },
    notificationTransport() {
      return {
        async send(event) {
          rememberSent(await sendText(connection.socket, administratorJid, formatWhatsAppMessage(event)));
          return { providerMessageId: "accepted" };
        },
      };
    },
    onMessage(next) {
      handler = next;
    },
    waitUntilClosed: () => closed,
    close: () => connection.close(),
  };
}

/** Test seam: verifies connection and QR behavior without contacting WhatsApp. */
export async function loginWhatsAppForTesting(options: WhatsAppLoginOptions, runtimeOptions: BaileysRuntime): Promise<void> {
  const connection = await connect(options, runtimeOptions);
  await connection.close();
}
