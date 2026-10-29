import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** A validated snapshot root. `realRoot` is used for escape checks only. */
export interface Snapshot {
  /** Normalized path exactly as the caller provided it (no symlink resolution). */
  root: string;
  /** Fully resolved path, used to detect symlinks that leave the snapshot. */
  realRoot: string;
}

export type SnapshotCheck =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; reason: "not-absolute" | "not-a-directory" };

export async function checkSnapshot(dir: string): Promise<SnapshotCheck> {
  if (typeof dir !== "string" || !isAbsolute(dir)) return { ok: false, reason: "not-absolute" };
  const root = resolve(dir);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) return { ok: false, reason: "not-a-directory" };
    return { ok: true, snapshot: { root, realRoot: await realpath(root) } };
  } catch {
    return { ok: false, reason: "not-a-directory" };
  }
}

export function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

export type InsideCheck =
  | { ok: true; absolute: string; relative: string }
  | { ok: false; reason: "escapes-snapshot" | "not-found" | "not-a-file" };

/**
 * Resolve a snapshot-relative file path and refuse anything that leaves the
 * snapshot, whether through `..`, an absolute path or a symlink.
 */
export async function resolveInside(snapshot: Snapshot, rel: string): Promise<InsideCheck> {
  if (typeof rel !== "string" || rel === "" || isAbsolute(rel)) return { ok: false, reason: "escapes-snapshot" };
  const absolute = resolve(snapshot.root, rel);
  if (!isInside(snapshot.root, absolute)) return { ok: false, reason: "escapes-snapshot" };
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const target = await realpath(absolute);
      if (!isInside(snapshot.realRoot, target)) return { ok: false, reason: "escapes-snapshot" };
      const targetInfo = await stat(target);
      if (!targetInfo.isFile()) return { ok: false, reason: "not-a-file" };
    } else if (!info.isFile()) {
      return { ok: false, reason: "not-a-file" };
    }
  } catch {
    return { ok: false, reason: "not-found" };
  }
  return { ok: true, absolute, relative: relative(snapshot.root, absolute) };
}

export interface WalkResult {
  /** Regular files, relative to the root, sorted. */
  files: string[];
  /** Symbolic links (files or directories), relative to the root, sorted. Not followed. */
  symlinks: string[];
}

/** List the snapshot without following symlinks. */
export async function walkSnapshot(snapshot: Snapshot): Promise<WalkResult> {
  const files: string[] = [];
  const symlinks: string[] = [];
  const pending: string[] = [snapshot.root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(snapshot.root, full);
      if (entry.isSymbolicLink()) symlinks.push(rel);
      else if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) files.push(rel);
    }
  }
  files.sort();
  symlinks.sort();
  return { files, symlinks };
}

/** Relative path of a tool-reported file, or null when it is outside the root. */
export function relativeInside(snapshot: Snapshot, reported: string): string | null {
  const absolute = isAbsolute(reported) ? resolve(reported) : resolve(snapshot.root, reported);
  if (!isInside(snapshot.root, absolute)) return null;
  return relative(snapshot.root, absolute);
}
