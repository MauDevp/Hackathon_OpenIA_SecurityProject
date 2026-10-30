import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  adminChatMenu,
  acquireAdminChatLock,
  clearPendingDependencyRepair,
  clearPendingPnpmInstall,
  createPendingDependencyRepair,
  createPendingPnpmInstall,
  dependencyRepairArguments,
  dependencyRepairProposalMessage,
  loadPendingDependencyRepair,
  loadPendingPnpmInstall,
  packageManagerForLockfiles,
  parseAdminCommand,
  pnpmInstallProposalMessage,
  pnpmVersionFromPackageManager,
  releaseAdminChatLock,
} from "../../src/admin/chat.js";
import { isAuthorizedAdminMessage } from "../../src/notifications/whatsapp.js";
import { writeAdminChatUnit } from "../../src/admin/service.js";

test("administrator chat accepts only its small allowlist", () => {
  assert.deepEqual(parseAdminCommand(" revisar "), { kind: "review" });
  assert.deepEqual(parseAdminCommand("1"), { kind: "review" });
  assert.deepEqual(parseAdminCommand("3. REPARAR DEPENDENCIAS"), { kind: "repair_dependencies" });
  assert.deepEqual(parseAdminCommand("REPARAR DEPENDENCIAS"), { kind: "repair_dependencies" });
  assert.deepEqual(parseAdminCommand("INSTALAR PNPM"), { kind: "install_pnpm" });
  assert.deepEqual(parseAdminCommand("6"), { kind: "install_pnpm" });
  assert.deepEqual(parseAdminCommand("confirmar abcdef123456"), { kind: "confirm", token: "ABCDEF123456" });
  assert.deepEqual(parseAdminCommand("ejecuta npm install"), { kind: "unknown" });
  assert.match(adminChatMenu(), /¿Qué quieres ejecutar/);
  assert.match(adminChatMenu(), /CONFIRMAR <código>/);
  assert.match(adminChatMenu(), /INSTALAR PNPM/);
});

test("pnpm bootstrap only accepts a stable version declared by packageManager", () => {
  assert.equal(pnpmVersionFromPackageManager("pnpm@10.13.1"), "10.13.1");
  assert.equal(pnpmVersionFromPackageManager("pnpm@10.13.1+sha512.abcdef"), "10.13.1");
  assert.equal(pnpmVersionFromPackageManager("pnpm@10.13.1-beta.1"), null);
  assert.equal(pnpmVersionFromPackageManager("npm@10.9.0"), null);
  assert.equal(pnpmVersionFromPackageManager("pnpm@10.13.1 --unsafe-perm"), null);
});

test("repair arguments are fixed by the selected package manager", () => {
  assert.deepEqual(packageManagerForLockfiles(["package-lock.json"]), { packageManager: "npm", lockfile: "package-lock.json" });
  assert.deepEqual(packageManagerForLockfiles(["apps/api/pnpm-lock.yaml"]), { packageManager: "pnpm", lockfile: "apps/api/pnpm-lock.yaml" });
  assert.equal(packageManagerForLockfiles(["package-lock.json", "pnpm-lock.yaml"]), null);
  assert.equal(packageManagerForLockfiles(["app/package-lock.json", "web/package-lock.json"]), null);
  assert.deepEqual(dependencyRepairArguments("npm"), ["audit", "fix", "--package-lock-only", "--ignore-scripts"]);
  assert.deepEqual(dependencyRepairArguments("pnpm"), ["audit", "--fix", "--ignore-scripts"]);
});

test("a dependency repair requires a private expiring confirmation token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dmsecurity-admin-chat-"));
  const environment = { DMSECURITY_STATE_DIR: directory };
  try {
    const now = new Date("2026-10-30T12:00:00.000Z");
    const proposal = await createPendingDependencyRepair({
      repository: "/safe/repository",
      ref: "main",
      commit: "a".repeat(40),
      lockfile: "pnpm-lock.yaml",
      lockfileSha256: "b".repeat(64),
      packageManager: "pnpm",
    }, environment, now);
    assert.match(proposal.token, /^[A-F0-9]{12}$/);
    assert.deepEqual(await loadPendingDependencyRepair(environment, now), proposal);
    const message = dependencyRepairProposalMessage(proposal);
    assert.match(message, /pnpm audit --fix --ignore-scripts/);
    assert.match(message, new RegExp(`CONFIRMAR ${proposal.token}`));
    assert.match(message, /no se hará --force/);
    assert.equal(await loadPendingDependencyRepair(environment, new Date("2026-10-30T12:11:00.000Z")), null);
    await clearPendingDependencyRepair(environment);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pnpm bootstrap requires a private expiring token and pins the version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dmsecurity-admin-pnpm-"));
  const environment = { DMSECURITY_STATE_DIR: directory };
  try {
    const now = new Date("2026-10-30T12:00:00.000Z");
    const proposal = await createPendingPnpmInstall({
      repository: "/safe/repository",
      ref: "main",
      commit: "a".repeat(40),
      packageJsonSha256: "b".repeat(64),
      pnpmVersion: "10.13.1",
    }, environment, now);
    assert.match(proposal.token, /^[A-F0-9]{12}$/);
    assert.deepEqual(await loadPendingPnpmInstall(environment, now), proposal);
    const message = pnpmInstallProposalMessage(proposal);
    assert.match(message, /pnpm@10\.13\.1 en ~\/\.local\/bin/);
    assert.match(message, /No se ejecutarán scripts/);
    assert.match(message, new RegExp(`CONFIRMAR ${proposal.token}`));
    assert.equal(await loadPendingPnpmInstall(environment, new Date("2026-10-30T12:11:00.000Z")), null);
    await clearPendingPnpmInstall(environment);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WhatsApp authorization rejects groups, self messages and other contacts", () => {
  const authorized = "5215550000000@s.whatsapp.net";
  assert.equal(isAuthorizedAdminMessage({ key: { remoteJid: authorized, fromMe: false } }, authorized), true);
  assert.equal(isAuthorizedAdminMessage({ key: { remoteJid: "123456789@lid", remoteJidAlt: authorized, fromMe: false } }, authorized), true);
  assert.equal(isAuthorizedAdminMessage({ key: { remoteJid: "5214440000000@s.whatsapp.net", fromMe: false } }, authorized), false);
  assert.equal(isAuthorizedAdminMessage({ key: { remoteJid: "12345@g.us", fromMe: false } }, authorized), false);
  assert.equal(isAuthorizedAdminMessage({ key: { remoteJid: authorized, fromMe: true } }, authorized), false);
  assert.equal(isAuthorizedAdminMessage({ key: { remoteJid: authorized, fromMe: true, id: "from-phone" } }, authorized, { allowOwnMessages: true }), true);
  assert.equal(isAuthorizedAdminMessage(
    { key: { remoteJid: authorized, fromMe: true, id: "from-dmsecurity" } },
    authorized,
    { allowOwnMessages: true, sentByDmsecurity: new Set(["from-dmsecurity"]) },
  ), false);
});

test("administrator chat lock is exclusive and can only be released by its owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dmsecurity-admin-lock-"));
  const environment = { DMSECURITY_STATE_DIR: directory };
  try {
    const first = await acquireAdminChatLock(environment);
    assert.ok(first);
    assert.equal(await acquireAdminChatLock(environment), null);
    await releaseAdminChatLock({ instanceId: "not-the-owner" }, environment);
    assert.equal(await acquireAdminChatLock(environment), null);
    await releaseAdminChatLock(first as NonNullable<typeof first>, environment);
    assert.ok(await acquireAdminChatLock(environment));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("administrator chat service uses the local Node entrypoint and restarts safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dmsecurity-admin-unit-"));
  try {
    const unit = await writeAdminChatUnit("/opt/dmsecurity/dist/cli/index.js", "/opt/dmsecurity/node/bin/node", {
      DMSECURITY_SYSTEMD_USER_DIR: directory,
    });
    const content = await readFile(unit, "utf8");
    assert.match(content, /ExecStart="\/opt\/dmsecurity\/node\/bin\/node" "\/opt\/dmsecurity\/dist\/cli\/index\.js" admin-chat/);
    assert.match(content, /Restart=on-failure/);
    assert.match(content, /Environment=PATH="\/opt\/dmsecurity\/node\/bin:\/home\/diego-martell\/\.local\/bin:\/home\/diego-martell\/\.local\/share\/pnpm:\/usr\/local\/bin:\/usr\/bin:\/bin"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
