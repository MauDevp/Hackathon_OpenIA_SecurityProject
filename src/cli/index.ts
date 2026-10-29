#!/usr/bin/env node

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { scanAll } from "../adapters/index.js";
import type { AnalysisResult, ScanAll } from "../contracts.js";
import { orchestrate, snapshotFailure } from "../core/orchestrator.js";
import { serializeReport, terminalSummary } from "../core/report.js";
import {
  assertOutputOutsideRepository,
  cleanupSnapshot,
  createSnapshot,
  SnapshotError,
} from "../core/snapshot.js";

export interface ScanArguments {
  repo: string;
  ref: string;
  out: string;
  strictOffline: boolean;
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function usage(): string {
  return [
    "Usage:",
    "  guardia scan --repo <path> --ref <git-ref> --out <report.json> [--strict-offline]",
    "",
    "The report path must be outside the repository being analyzed.",
  ].join("\n");
}

export function parseArguments(argv: string[]): ScanArguments {
  if (argv[0] !== "scan") {
    throw new CliError(`Expected the 'scan' command.\n${usage()}`);
  }
  const values: Partial<Record<"repo" | "ref" | "out", string>> = {};
  let strictOffline = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict-offline") {
      if (strictOffline) throw new CliError("--strict-offline was supplied more than once.");
      strictOffline = true;
      continue;
    }
    if (argument !== "--repo" && argument !== "--ref" && argument !== "--out") {
      throw new CliError(`Unknown option ${JSON.stringify(argument)}.\n${usage()}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`${argument} requires a value.`);
    }
    const key = argument.slice(2) as "repo" | "ref" | "out";
    if (values[key] !== undefined) throw new CliError(`${argument} was supplied more than once.`);
    values[key] = value;
    index += 1;
  }
  if (!values.repo) throw new CliError("--repo is required.");
  if (!values.ref) throw new CliError("--ref is required.");
  if (!values.out) throw new CliError("--out is required.");
  return { repo: values.repo, ref: values.ref, out: values.out, strictOffline };
}

async function validateRepositoryDirectory(repository: string): Promise<string> {
  try {
    const info = await stat(repository);
    if (!info.isDirectory()) throw new CliError("--repo must name an existing directory.");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("--repo must name an existing directory.");
  }
  return resolve(repository);
}

async function writeReport(path: string, result: AnalysisResult): Promise<void> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.guardia-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporary, serializeReport(result), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    // The temporary filename is unique per process/time. Do not try to remove
    // an unknown path in an error handler.
    throw new CliError("Could not write the report at the requested output path.");
  }
}

export interface ExecuteOptions {
  scanAll?: ScanAll;
}

/** Executes one scan and always removes the snapshot created for it. */
export async function executeScan(args: ScanArguments, dependencies: ExecuteOptions = {}): Promise<{ result: AnalysisResult; output: string }> {
  const repository = await validateRepositoryDirectory(args.repo);
  let output: string;
  try {
    output = await assertOutputOutsideRepository(repository, args.out);
  } catch (error) {
    if (error instanceof SnapshotError) throw new CliError(error.message);
    throw new CliError("--out could not be resolved safely.");
  }

  const isolation = args.strictOffline ? "unverified" : "not_requested";
  let result: AnalysisResult;
  try {
    const snapshot = await createSnapshot(repository, args.ref);
    try {
      result = await orchestrate({
        snapshot,
        scanAll: dependencies.scanAll ?? scanAll,
        strictOffline: args.strictOffline,
        isolation,
      });
    } finally {
      await cleanupSnapshot(snapshot);
    }
  } catch (error) {
    const message = error instanceof SnapshotError
      ? error.message
      : "A safe snapshot could not be prepared.";
    result = snapshotFailure(message, args.strictOffline, isolation);
  }

  await writeReport(output, result);
  return { result, output };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    const args = parseArguments(argv);
    const { result, output } = await executeScan(args);
    process.stdout.write(terminalSummary(result, output));
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected CLI failure.";
    process.stderr.write(`guardia: ${message}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1];
const invokedAsProgram = invokedPath !== undefined
  && import.meta.url === pathToFileURL(resolve(invokedPath)).href;
if (invokedAsProgram) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
