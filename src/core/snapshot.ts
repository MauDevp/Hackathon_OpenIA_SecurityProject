import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Snapshot } from "../contracts.js";

const execFile = promisify(execFileCallback);
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "poetry.lock",
  "Pipfile.lock",
  "requirements.txt",
  "uv.lock",
  "pdm.lock",
]);

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

interface GitTreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

interface GitIndexEntry {
  mode: string;
  object: string;
  stage: string;
  path: string;
}

function sanitiseGitError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "Git is not available on PATH.";
    }
  }
  return fallback;
}

async function git(repository: string, args: string[], maxBuffer = MAX_BLOB_BYTES): Promise<string | Buffer> {
  try {
    const result = await execFile("git", ["-C", repository, ...args], {
      encoding: "buffer",
      maxBuffer,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    throw new SnapshotError(sanitiseGitError(error, "Git could not read the requested repository data."));
  }
}

function asUtf8(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

/** True only for a normalized, POSIX-style path below the snapshot root. */
export function isSafeRelativePath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.includes("\0") || isAbsolute(candidate)) {
    return false;
  }

  const segments = candidate.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function isPathInside(parent: string, candidate: string): boolean {
  const between = relative(resolve(parent), resolve(candidate));
  return between !== "" && between !== ".." && !between.startsWith(`..${sep}`) && !isAbsolute(between);
}

function parseTree(raw: Buffer): GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  for (const record of raw.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^(\d+) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record);
    if (!match) {
      throw new SnapshotError("Git returned an invalid tree entry.");
    }
    const [, mode, type, object, path] = match;
    if (!mode || !type || !object || !path || !isSafeRelativePath(path)) {
      throw new SnapshotError("The commit contains an unsafe path and cannot be snapshotted.");
    }
    entries.push({ mode, type, object, path });
  }
  return entries;
}

function parseIndex(raw: Buffer): GitIndexEntry[] {
  const entries: GitIndexEntry[] = [];
  for (const record of raw.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^(\d+) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/.exec(record);
    if (!match) throw new SnapshotError("Git returned an invalid index entry.");
    const [, mode, object, stage, path] = match;
    if (!mode || !object || !stage || !path || !isSafeRelativePath(path)) {
      throw new SnapshotError("The index contains an unsafe path and cannot be snapshotted.");
    }
    entries.push({ mode, object, stage, path });
  }
  return entries;
}

async function resolveRepository(repository: string): Promise<string> {
  try {
    const info = await stat(repository);
    if (!info.isDirectory()) {
      throw new SnapshotError("--repo must name an existing directory.");
    }
    return await realpath(repository);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError("--repo must name an existing directory.");
  }
}

async function resolveCommit(repository: string, ref: string): Promise<string> {
  try {
    const raw = await git(repository, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], 1024 * 1024);
    const commit = asUtf8(raw).trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) {
      throw new SnapshotError("The requested reference did not resolve to a commit.");
    }
    return commit;
  } catch (error) {
    if (error instanceof SnapshotError && error.message === "Git is not available on PATH.") throw error;
    throw new SnapshotError(`The Git reference ${JSON.stringify(ref)} does not exist or is not a commit.`);
  }
}

function isLockfile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return LOCKFILE_NAMES.has(name);
}

async function copyBlob(
  repository: string,
  snapshotDir: string,
  mode: string,
  object: string,
  path: string,
): Promise<void> {
  const destination = resolve(snapshotDir, ...path.split("/"));
  if (!isPathInside(snapshotDir, destination)) {
    throw new SnapshotError("A snapshot entry resolved outside its temporary directory.");
  }
  const content = await git(repository, ["cat-file", "blob", object]);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, {
    flag: "wx",
    mode: mode === "100755" ? 0o700 : 0o600,
  });
}

/**
 * Materializes tracked regular blobs from a commit without checking anything out
 * into the repository under review. Symlinks and gitlinks are deliberately not
 * followed, so an adapter can never escape the snapshot through one.
 */
export async function createSnapshot(repositoryInput: string, ref: string): Promise<Snapshot> {
  const repository = await resolveRepository(repositoryInput);
  const commit = await resolveCommit(repository, ref);
  const snapshotDir = await mkdtemp(join(tmpdir(), "guardia-snapshot-"));
  const excluded: string[] = [];
  const omitted: string[] = [];
  const lockfiles: string[] = [];

  try {
    const tree = await git(repository, ["ls-tree", "-r", "-z", "--full-tree", commit]);
    for (const entry of parseTree(Buffer.isBuffer(tree) ? tree : Buffer.from(tree))) {
      if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
        excluded.push(`${entry.path}: skipped ${entry.type === "commit" ? "gitlink" : "non-regular entry"}`);
        continue;
      }

      try {
        await copyBlob(repository, snapshotDir, entry.mode, entry.object, entry.path);
        if (isLockfile(entry.path)) lockfiles.push(entry.path);
      } catch {
        omitted.push(`${entry.path}: could not copy blob`);
      }
    }

    return {
      repository,
      commit,
      snapshotDir,
      lockfiles: lockfiles.sort(),
      excluded,
      omitted,
      complete: excluded.length === 0 && omitted.length === 0,
    };
  } catch (error) {
    await rm(snapshotDir, { recursive: true, force: true });
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError("The commit could not be copied into a safe snapshot.");
  }
}

/**
 * Creates a private snapshot from the staged Git index. This is deliberately
 * read-only with respect to the source repository: it reads index entries and
 * blobs directly and never calls checkout, write-tree or stash.
 */
export async function createIndexSnapshot(repositoryInput: string): Promise<Snapshot> {
  const repository = await resolveRepository(repositoryInput);
  const snapshotDir = await mkdtemp(join(tmpdir(), "guardia-index-"));
  const excluded: string[] = [];
  const omitted: string[] = [];
  const lockfiles: string[] = [];

  try {
    const index = await git(repository, ["ls-files", "--cached", "--stage", "-z"]);
    for (const entry of parseIndex(Buffer.isBuffer(index) ? index : Buffer.from(index))) {
      if (entry.stage !== "0") {
        omitted.push(`${entry.path}: unmerged index entry`);
        continue;
      }
      if (entry.mode !== "100644" && entry.mode !== "100755") {
        excluded.push(`${entry.path}: skipped non-regular index entry`);
        continue;
      }
      try {
        await copyBlob(repository, snapshotDir, entry.mode, entry.object, entry.path);
        if (isLockfile(entry.path)) lockfiles.push(entry.path);
      } catch {
        omitted.push(`${entry.path}: could not copy staged blob`);
      }
    }
    return {
      repository,
      commit: null,
      snapshotDir,
      lockfiles: lockfiles.sort(),
      excluded,
      omitted,
      complete: excluded.length === 0 && omitted.length === 0,
    };
  } catch (error) {
    await rm(snapshotDir, { recursive: true, force: true });
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError("The staged index could not be copied into a safe snapshot.");
  }
}

export async function cleanupSnapshot(snapshot: Snapshot): Promise<void> {
  await rm(snapshot.snapshotDir, { recursive: true, force: true });
}

/**
 * Resolves an output path through existing parent symlinks before checking it,
 * preventing `--out repo-link/report.json` from bypassing the repository check.
 */
async function canonicalizeFuturePath(input: string): Promise<string> {
  let current = resolve(input);
  const tail: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(current);
      return resolve(canonical, ...tail.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      tail.push(basename(current));
      current = parent;
    }
  }
}

export async function assertOutputOutsideRepository(repository: string, output: string): Promise<string> {
  const canonicalRepository = await realpath(repository);
  const canonicalOutput = await canonicalizeFuturePath(output);
  if (isPathInside(canonicalRepository, canonicalOutput) || canonicalOutput === canonicalRepository) {
    throw new SnapshotError("--out must be outside the repository being analyzed.");
  }
  return canonicalOutput;
}

export async function assertReadable(path: string): Promise<void> {
  try {
    await access(path, fsConstants.R_OK);
  } catch {
    throw new SnapshotError("The requested path is not readable.");
  }
}
