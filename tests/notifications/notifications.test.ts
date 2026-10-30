import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AnalysisResult } from "../../src/contracts.js";
import { actionMenu, commandReference, detailedSecurityReport } from "../../src/cli/presentation.js";
import { eventFromAnalysis, formatWhatsAppMessage } from "../../src/notifications/formatter.js";
import { deliverPendingNotifications, queueNotification } from "../../src/notifications/outbox.js";
import { loadSecurityTarget, loadWhatsAppSettings, saveSecurityTarget, saveWhatsAppSettings } from "../../src/notifications/settings.js";
import { loginWhatsAppForTesting, whatsAppOptionsFromEnvironment, type BaileysRuntime } from "../../src/notifications/whatsapp.js";

const SECRET = "DEMO_GUARDIA_FAKE_TOKEN_0123456789";

function findingsResult(): AnalysisResult {
  return {
    status: "FINDINGS",
    exitCode: 1,
    snapshot: {
      repository: "/input/repository",
      commit: "a".repeat(40),
      snapshotDir: "/tmp/snapshot",
      lockfiles: ["package-lock.json"],
      excluded: [],
      omitted: [],
      complete: true,
    },
    isolation: "not_requested",
    strictOffline: false,
    scanners: [
      { scanner: "osv", status: "ok", version: "test", filesAnalyzed: ["package-lock.json"], omitted: [], findings: [] },
      { scanner: "gitleaks", status: "ok", version: "test", filesAnalyzed: [], omitted: [], findings: [] },
    ],
    findings: [{ scanner: "gitleaks", type: "secret", id: "demo", path: "config.txt", summary: SECRET }],
  };
}

test("formats a redacted event and deduplicates delivered WhatsApp notifications", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "dmsecurity-outbox-"));
  try {
    const event = eventFromAnalysis(findingsResult(), `api-${SECRET}`, "HEAD", "scheduled");
    const message = formatWhatsAppMessage(event);
    assert.doesNotMatch(message, new RegExp(SECRET));
    assert.match(message, /DMsecurity 🛡️/);
    assert.match(message, /Repositorio:/);
    assert.match(message, /Revisé:/);
    assert.match(message, /1 posible secreto expuesto \(gitleaks\)/);
    assert.match(message, /Mejora recomendada:/);

    const onboardingMessage = formatWhatsAppMessage({ ...event, trigger: "onboarding" });
    assert.match(onboardingMessage, /Configuración completada/);
    assert.match(onboardingMessage, /Resumen de la primera revisión/);

    const first = await queueNotification(event, { stateDir });
    const duplicate = await queueNotification(event, { stateDir });
    assert.equal(first.status, "queued");
    assert.equal(duplicate.status, "skipped");

    const received: string[] = [];
    const deliveries = await deliverPendingNotifications({
      async send(value) {
        received.push(formatWhatsAppMessage(value));
        return { providerMessageId: "message-1" };
      },
    }, { stateDir });
    assert.equal(deliveries[0]?.status, "sent");
    assert.equal(received.length, 1);
    assert.doesNotMatch(received[0] as string, new RegExp(SECRET));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a provider failure is retried without persisting its raw error", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "dmsecurity-outbox-"));
  try {
    const event = eventFromAnalysis(findingsResult(), "api", "HEAD", "scheduled");
    await queueNotification(event, { stateDir, now: new Date("2026-01-01T00:00:00Z") });
    const delivery = await deliverPendingNotifications({
      async send() {
        throw new Error(`provider returned ${SECRET}`);
      },
    }, { stateDir, now: new Date("2026-01-01T00:00:00Z") });
    assert.equal(delivery[0]?.status, "queued");
    assert.equal(delivery[0]?.failure?.stage, "delivery");
    const pending = await readFile(join(stateDir, "outbox", "pending", `${delivery[0]?.dedupeKey}.json`), "utf8");
    assert.match(pending, /delivery failed/);
    assert.doesNotMatch(pending, new RegExp(SECRET));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("concurrent outbox workers claim one alert atomically", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "dmsecurity-outbox-"));
  try {
    const event = eventFromAnalysis(findingsResult(), "api", "HEAD", "scheduled");
    await queueNotification(event, { stateDir });
    let sends = 0;
    let releaseSend: (() => void) | undefined;
    const sending = new Promise<void>((resolve) => { releaseSend = resolve; });
    let announceStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { announceStart = resolve; });
    const transport = {
      async send() {
        sends += 1;
        announceStart?.();
        await sending;
        return { providerMessageId: "message-1" };
      },
    };
    const first = deliverPendingNotifications(transport, { stateDir });
    await started;
    const duplicateWhileInflight = await queueNotification(event, { stateDir });
    assert.equal(duplicateWhileInflight.status, "skipped");
    const second = deliverPendingNotifications(transport, { stateDir });
    releaseSend?.();
    await Promise.all([first, second]);
    assert.equal(sends, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a notification that exhausted retries is not re-enqueued for the same fingerprint", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "dmsecurity-outbox-"));
  try {
    const event = eventFromAnalysis(findingsResult(), "api", "HEAD", "scheduled");
    await queueNotification(event, { stateDir, now: new Date("2026-01-01T00:00:00Z") });
    for (let hour = 0; hour < 5; hour += 1) {
      await deliverPendingNotifications({
        async send() { throw new Error("offline"); },
      }, { stateDir, now: new Date(`2026-01-01T0${hour}:00:00Z`) });
    }
    const duplicateAfterFailure = await queueNotification(event, { stateDir });
    assert.equal(duplicateAfterFailure.status, "skipped");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("the detailed local view lists redacted locations and correction guidance", () => {
  const detail = detailedSecurityReport(findingsResult());
  assert.match(detail, /Posible secreto expuesto/);
  assert.match(detail, /Ubicación: config\.txt/);
  assert.match(detail, /Cómo corregirlo/);
  assert.match(detail, /revoca y rota la credencial/);
  assert.doesNotMatch(detail, new RegExp(SECRET));
});

test("the action menu and command reference explain the available DMsecurity actions", () => {
  const menu = actionMenu();
  assert.match(menu, /1\. login/);
  assert.match(menu, /4\. comandos/);
  assert.match(menu, /5\. chequeo detallado/);
  assert.doesNotMatch(menu, /verificación rápida/);
  const commands = commandReference();
  assert.match(commands, /Comando/);
  assert.match(commands, /Qué hace/);
  assert.match(commands, /Ingresa un comando de la tabla o presiona 0 para regresar/);
});

test("a transport can report a safe failure stage without persisting provider details", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "dmsecurity-outbox-"));
  try {
    const event = eventFromAnalysis(findingsResult(), "api", "HEAD", "scheduled");
    await queueNotification(event, { stateDir, now: new Date("2026-01-01T00:00:00Z") });
    const delivery = await deliverPendingNotifications({
      async send() {
        throw Object.assign(new Error(SECRET), { notificationFailure: { stage: "recipient" } });
      },
    }, { stateDir, now: new Date("2026-01-01T00:00:00Z") });
    assert.equal(delivery[0]?.failure?.stage, "recipient");
    const pending = await readFile(join(stateDir, "outbox", "pending", `${delivery[0]?.dedupeKey}.json`), "utf8");
    assert.match(pending, /"lastFailure":\{"stage":"recipient"\}/);
    assert.doesNotMatch(pending, new RegExp(SECRET));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("WhatsApp QR login stores its session in a private local directory", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "dmsecurity-whatsapp-"));
  const authDir = join(stateDir, "auth");
  let socketCount = 0;
  let closed = 0;
  const runtime: BaileysRuntime = {
    makeSocket() {
      const number = socketCount;
      socketCount += 1;
      const listeners: Array<(update: Record<string, unknown>) => void> = [];
      const socket = {
        ev: {
          on(event: string, listener: (update: Record<string, unknown>) => void) {
            if (event === "connection.update") listeners.push(listener);
          },
        },
        async end() { closed += 1; },
      };
      queueMicrotask(() => {
        if (number === 0) {
          for (const listener of listeners) listener({ qr: "qr-test-value" });
          for (const listener of listeners) listener({ connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
        } else {
          for (const listener of listeners) listener({ connection: "open" });
        }
      });
      return socket as never;
    },
    async useAuthState() {
      return { state: {}, saveCreds: async () => {} } as never;
    },
    renderQr() {},
  };
  try {
    let qr: string | undefined;
    await loginWhatsAppForTesting({ authDir, onQr: (value) => { qr = value; } }, runtime);
    assert.equal(qr, "qr-test-value");
    assert.equal((await stat(authDir)).mode & 0o777, 0o700);
    assert.equal(socketCount, 2);
    assert.equal(closed, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("WhatsApp transport needs only a recipient, never a cloud API token", async () => {
  assert.deepEqual(
    await whatsAppOptionsFromEnvironment({ DMSECURITY_WHATSAPP_RECIPIENT: "+52 1555 000 0000" }),
    { recipient: "+52 1555 000 0000" },
  );
  const configuration = await mkdtemp(join(tmpdir(), "dmsecurity-whatsapp-config-"));
  try {
    const environment = { DMSECURITY_CONFIG_DIR: configuration };
    await assert.rejects(() => whatsAppOptionsFromEnvironment(environment), /DMSECURITY_WHATSAPP_RECIPIENT/);
    await saveWhatsAppSettings("+52 1555 000 0000", environment);
    assert.deepEqual(await loadWhatsAppSettings(environment), { version: 1, recipient: "5215550000000" });
    assert.deepEqual(await whatsAppOptionsFromEnvironment(environment), { recipient: "5215550000000" });
    assert.equal((await stat(join(configuration, "whatsapp.json"))).mode & 0o777, 0o600);
    await saveSecurityTarget("/tmp/project", "main", environment);
    assert.deepEqual(await loadSecurityTarget(environment), { version: 1, repository: "/tmp/project", ref: "main" });
    assert.equal((await stat(join(configuration, "target.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(configuration, { recursive: true, force: true });
  }
});
