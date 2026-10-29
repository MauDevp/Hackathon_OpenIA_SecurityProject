import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addSchedule, listSchedules, removeSchedule, writeScheduleUnits } from "../../src/schedule.js";

test("stores a schedule and renders disabled systemd user units", async () => {
  const root = await mkdtemp(join(tmpdir(), "dmsecurity-schedule-"));
  const oldConfig = process.env.DMSECURITY_CONFIG_DIR;
  const oldSystemd = process.env.DMSECURITY_SYSTEMD_USER_DIR;
  process.env.DMSECURITY_CONFIG_DIR = join(root, "config");
  process.env.DMSECURITY_SYSTEMD_USER_DIR = join(root, "systemd");
  try {
    const entry = await addSchedule({
      repository: "/repos/api",
      ref: "main",
      every: "6h",
      notify: "whatsapp",
      on: ["findings", "incomplete"],
    });
    assert.equal((await listSchedules()).length, 1);
    const units = await writeScheduleUnits(entry, "/opt/dmsecurity/scripts/scheduled-scan.sh");
    assert.match(await readFile(units.timer, "utf8"), /OnUnitActiveSec=6h/);
    assert.match(await readFile(units.service, "utf8"), /GUARDIA_NOTIFY=whatsapp/);
    assert.match(await readFile(units.service, "utf8"), /DMSECURITY_NODE_BIN=/);
    assert.equal(await removeSchedule(entry.id), true);
    assert.deepEqual(await listSchedules(), []);
  } finally {
    if (oldConfig === undefined) delete process.env.DMSECURITY_CONFIG_DIR;
    else process.env.DMSECURITY_CONFIG_DIR = oldConfig;
    if (oldSystemd === undefined) delete process.env.DMSECURITY_SYSTEMD_USER_DIR;
    else process.env.DMSECURITY_SYSTEMD_USER_DIR = oldSystemd;
    await rm(root, { recursive: true, force: true });
  }
});
