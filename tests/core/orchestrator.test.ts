import assert from "node:assert/strict";
import test from "node:test";

import type { ScanAll, ScannerResult, Snapshot } from "../../src/contracts.js";
import { orchestrate } from "../../src/core/orchestrator.js";
import { createReport, terminalSummary } from "../../src/core/report.js";

const snapshot: Snapshot = {
  repository: "/input/repository",
  commit: "a".repeat(40),
  snapshotDir: "/tmp/guardia-test-snapshot",
  lockfiles: ["package-lock.json"],
  excluded: [],
  omitted: [],
  complete: true,
};

function scanner(scanner: ScannerResult["scanner"], status: ScannerResult["status"], findings: ScannerResult["findings"] = []): ScannerResult {
  return { scanner, status, version: "test", filesAnalyzed: [], omitted: [], findings };
}

function adapters(results: ScannerResult[]): ScanAll {
  return async () => results;
}

test("returns PASS only after both required scanners finish without findings", async () => {
  const result = await orchestrate({
    snapshot,
    scanAll: adapters([scanner("osv", "ok"), scanner("gitleaks", "ok")]),
    strictOffline: false,
    isolation: "not_requested",
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.exitCode, 0);
});

test("returns FINDINGS when complete scanners report a finding", async () => {
  const result = await orchestrate({
    snapshot,
    scanAll: adapters([
      scanner("osv", "ok", [{ scanner: "osv", type: "dependency", id: "OSV-1", path: "package-lock.json", summary: "demo advisory" }]),
      scanner("gitleaks", "ok"),
    ]),
    strictOffline: false,
    isolation: "not_requested",
  });
  assert.equal(result.status, "FINDINGS");
  assert.equal(result.exitCode, 1);
});

test("missing or failed coverage wins over findings and preserves them", async () => {
  const finding = { scanner: "osv" as const, type: "dependency" as const, id: "OSV-1", path: "package-lock.json", summary: "demo advisory" };
  const result = await orchestrate({
    snapshot,
    scanAll: adapters([scanner("osv", "ok", [finding]), scanner("gitleaks", "missing")]),
    strictOffline: false,
    isolation: "not_requested",
  });
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.findings, [finding]);
});

test("a scanner error makes the result incomplete", async () => {
  const result = await orchestrate({
    snapshot,
    scanAll: adapters([scanner("osv", "error"), scanner("gitleaks", "ok")]),
    strictOffline: false,
    isolation: "not_requested",
  });
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.exitCode, 2);
});

test("strict offline remains incomplete until isolation is verified", async () => {
  const result = await orchestrate({
    snapshot,
    scanAll: adapters([scanner("osv", "ok"), scanner("gitleaks", "ok")]),
    strictOffline: true,
    isolation: "unverified",
  });
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.exitCode, 2);
});

test("report and terminal summary redact a synthetic secret", () => {
  const secret = "DEMO_GUARDIA_FAKE_TOKEN_0123456789";
  const result = {
    status: "FINDINGS" as const,
    exitCode: 1 as const,
    snapshot,
    isolation: "not_requested" as const,
    strictOffline: false,
    scanners: [
      scanner("osv", "ok"),
      scanner("gitleaks", "ok", [{ scanner: "gitleaks", type: "secret", id: "demo", path: "config.txt", summary: `matched ${secret}` }]),
    ],
    findings: [{ scanner: "gitleaks" as const, type: "secret" as const, id: "demo", path: "config.txt", summary: `matched ${secret}` }],
  };
  assert.doesNotMatch(JSON.stringify(createReport(result)), new RegExp(secret));
  assert.doesNotMatch(terminalSummary(result, "/tmp/report.json"), new RegExp(secret));
});
