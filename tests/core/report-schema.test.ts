import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import Ajv from "ajv";

import type { AnalysisResult, ScannerResult } from "../../src/contracts.js";
import { createReport, REPORT_FORMAT_VERSION } from "../../src/core/report.js";

const SCHEMA_PATH = join(import.meta.dirname, "..", "..", "schemas", `guardia-report-${REPORT_FORMAT_VERSION}.schema.json`);

async function loadValidator() {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8")) as object;
  const ajv = new Ajv({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

function scanner(name: ScannerResult["scanner"], overrides: Partial<ScannerResult> = {}): ScannerResult {
  return { scanner: name, status: "ok", version: "test", filesAnalyzed: [], omitted: [], findings: [], ...overrides };
}

const snapshot = {
  repository: "/repo",
  commit: "0123456789abcdef0123456789abcdef01234567",
  snapshotDir: "/tmp/snapshot",
  lockfiles: ["package-lock.json"],
  excluded: ["link -> target"],
  omitted: [],
  complete: true,
};

const executedAt = "2026-10-29T00:00:00.000Z";

test("PASS, FINDINGS and INCOMPLETE reports validate against the published schema", async () => {
  const validate = await loadValidator();

  const pass: AnalysisResult = {
    status: "PASS",
    exitCode: 0,
    snapshot,
    isolation: "not_requested",
    strictOffline: false,
    scanners: [
      scanner("osv", {
        filesAnalyzed: ["package-lock.json"],
        database: { downloadedAt: executedAt, sourceDate: null, sha256: "a".repeat(64) },
      }),
      scanner("gitleaks"),
    ],
    findings: [],
  };
  const finding = {
    scanner: "osv" as const,
    type: "dependency" as const,
    id: "GHSA-xxxx-yyyy-zzzz",
    path: "package-lock.json",
    line: 12,
    summary: "example@1.0.0: synthetic advisory",
  };
  const findings: AnalysisResult = {
    ...pass,
    status: "FINDINGS",
    exitCode: 1,
    scanners: [scanner("osv", { filesAnalyzed: ["package-lock.json"], findings: [finding] }), scanner("gitleaks")],
    findings: [finding],
  };
  const incomplete: AnalysisResult = {
    status: "INCOMPLETE",
    exitCode: 2,
    snapshot: null,
    snapshotError: "Git is not available on PATH.",
    isolation: "unverified",
    strictOffline: true,
    scanners: [
      scanner("osv", { status: "missing", version: null, omitted: ["package-lock.json: osv-scanner executable not found"], error: "missing" }),
      scanner("gitleaks", { status: "unsupported", version: null }),
    ],
    findings: [],
  };

  const sha256Repository: AnalysisResult = { ...pass, snapshot: { ...snapshot, commit: "f".repeat(64) } };

  for (const result of [pass, findings, incomplete, sha256Repository]) {
    const report = createReport(result, executedAt);
    assert.equal(validate(report), true, `${result.status}: ${JSON.stringify(validate.errors)}`);
  }
});

test("the schema rejects an unknown status, an extra property and a missing scanner field", async () => {
  const validate = await loadValidator();
  const base = createReport(
    {
      status: "PASS",
      exitCode: 0,
      snapshot,
      isolation: "not_requested",
      strictOffline: false,
      scanners: [scanner("osv"), scanner("gitleaks")],
      findings: [],
    },
    executedAt,
  );

  assert.equal(validate({ ...base, status: "SECURE" }), false);
  assert.equal(validate({ ...base, unexpected: true }), false);
  const { version: _version, ...withoutVersion } = base.scanners[0]!;
  assert.equal(validate({ ...base, scanners: [withoutVersion, base.scanners[1]] }), false);
});
