/**
 * ledger.ts — Shared lock and hash helpers for KB pipeline operations.
 *
 * Extracted from src/core/organize/ledger.ts in Phase 2 of the learnings
 * pipeline. Both organize and learn import from here; organize/ledger.ts
 * re-exports these for backward compatibility.
 *
 * LOAD-BEARING: acquireLock / releaseLock use PID-check semantics (not
 * O_EXCL). Concurrent-safety is per-process, which is sufficient because
 * organize/learn are single-threaded CLI tools. A small TOCTOU window is
 * acknowledged and documented; it is extremely rare in practice.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex hash of a file's raw bytes.
 * Used by both organize and learn for edit-detection (R-5) and ledger records.
 */
export async function hashFile(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Lock helpers
// ---------------------------------------------------------------------------

/**
 * Acquire a lock at the given absolute path.
 *
 * Algorithm:
 *   1. If .lock does not exist → write our PID and return.
 *   2. Read the PID. If the process is running (kill 0) → throw (busy).
 *      If ESRCH (no such process) → stale lock, remove and write ours.
 *      If EPERM (no permission to signal) → treat as alive, throw.
 *
 * @throws Error if another live process holds the lock.
 */
export async function acquireLock(lockPath: string): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  let existingPid: number | null = null;
  try {
    const content = await fs.readFile(lockPath, "utf8");
    existingPid = parseInt(content.trim(), 10);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // No lock file — proceed to acquire.
  }

  if (existingPid !== null && !Number.isNaN(existingPid)) {
    let processAlive = false;
    try {
      process.kill(existingPid, 0); // signal 0 = existence check only
      processAlive = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        processAlive = false; // stale lock
      } else if ((err as NodeJS.ErrnoException).code === "EPERM") {
        processAlive = true; // process exists, different owner
      } else {
        throw err;
      }
    }

    if (processAlive) {
      throw new Error(`lock held by PID ${existingPid}`);
    }

    // Stale lock — remove it.
    await fs.rm(lockPath, { force: true });
  }

  await fs.writeFile(lockPath, String(process.pid), "utf8");
}

/**
 * Release a lock at the given absolute path.
 * Safe to call even if the lock file is already gone (idempotent).
 */
export async function releaseLock(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { force: true });
}

/**
 * Check whether a lock file at the given absolute path is currently held by
 * a live process.
 *
 * Returns true if the lock exists AND the recorded PID is still running.
 * Returns false if the lock is absent or stale.
 *
 * LOAD-BEARING: used by applyLearnPlan to implement the R-6 cross-feature
 * guard — learn checks the organize lock path before writing, and organize
 * could similarly check the learn lock. Best-effort; TOCTOU acknowledged.
 */
export async function isLockHeld(lockPath: string): Promise<boolean> {
  let pid: number | null = null;
  try {
    const content = await fs.readFile(lockPath, "utf8");
    pid = parseInt(content.trim(), 10);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }

  if (pid === null || Number.isNaN(pid)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true; // alive, different owner
    throw err;
  }
}
