/**
 * move.ts — Atomic move helper for organize.
 *
 * Mirrors the rename-with-EXDEV-fallback pattern from moveToTrash (src/core/fs.ts:39-70).
 * Key difference: this moves between two KB paths (not to .trash/).
 *
 * LOAD-BEARING: the EXDEV fallback + empty-parent sweep replicate moveToTrash's
 * exact logic. Do NOT call moveToTrash itself — organize uses its own ledger under
 * .kb-index/organize/, not .trash/.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface MoveNoteOpts {
  /** Absolute path of the source file. */
  absSource: string;
  /** Absolute path of the destination file. */
  absTarget: string;
  /** KB root (used for empty-parent sweep boundary). */
  kbRoot: string;
  /** If true, skip the empty-parent sweep after the move. Default false. */
  keepEmptyDirs?: boolean;
}

/**
 * Atomically move a file from absSource to absTarget.
 *
 * Uses fs.rename first (atomic on same filesystem). Falls back to
 * fs.cp + fs.rm if the source and target are on different filesystems
 * (EXDEV error — rare, but possible if KB_ROOT spans mount points).
 *
 * After a successful move, sweeps empty parent directories up to (but not
 * including) the KB root, unless opts.keepEmptyDirs is true.
 *
 * Throws on any non-EXDEV rename error; callers must handle.
 */
export async function moveNote(opts: MoveNoteOpts): Promise<void> {
  const { absSource, absTarget, kbRoot, keepEmptyDirs = false } = opts;

  // Ensure target parent directory exists.
  await fs.mkdir(path.dirname(absTarget), { recursive: true });

  // Attempt atomic rename first — fastest path on same filesystem.
  try {
    await fs.rename(absSource, absTarget);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      // Cross-device move: fall back to copy + remove.
      // LOAD-BEARING: this matches moveToTrash's EXDEV handling exactly.
      // preserveTimestamps: true — maintain mtime for incremental drift detection (nit #4).
      await fs.cp(absSource, absTarget, { recursive: true, preserveTimestamps: true });
      await fs.rm(absSource, { recursive: true, force: true });
    } else {
      throw err;
    }
  }

  if (keepEmptyDirs) return;

  // Sweep empty parent directories up to (but not including) the KB root.
  // Keeps the visible tree tidy after a note is moved out of a folder.
  // LOAD-BEARING: matches the identical sweep in moveToTrash (fs.ts:55-69).
  let parent = path.dirname(absSource);
  while (parent !== kbRoot && parent.startsWith(kbRoot + path.sep)) {
    try {
      await fs.rmdir(parent); // only succeeds if empty
      parent = path.dirname(parent);
    } catch {
      // ENOTEMPTY or other error — stop sweeping. Not an error condition.
      break;
    }
  }
}
