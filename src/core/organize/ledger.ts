/**
 * ledger.ts — Append-only JSONL ledger for organize operations.
 *
 * Ledger lives at: <kbRoot>/.kb-index/organize/<ISO-timestamp>.jsonl
 *
 * Record shapes (one JSON object per line):
 *
 *   { "kind": "header",  "generatedAt": string, "mode": "full"|"incremental", "minConfidence": number }
 *   { "kind": "move",    "from": string, "to": string, "contentHash": string, "reason": string, "confidence": number }
 *   { "kind": "rewrite", "file": string, "before": string, "after": string, "byteOffset": number, "linkKind": "wiki-path"|"md-path" }
 *   { "kind": "commit",  "applied": number, "skipped": number }
 *
 * Writer: appends with fs.appendFile (safe for crash-recovery — a partial
 * ledger is still readable line-by-line).
 *
 * Reader: parses line-by-line, tolerates trailing newline and blank lines.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

export interface LedgerHeaderRecord {
  kind: "header";
  generatedAt: string;
  mode: "full" | "incremental";
  minConfidence: number;
}

export interface LedgerMoveRecord {
  kind: "move";
  from: string;
  to: string;
  contentHash: string;
  reason: string;
  confidence: number;
}

export interface LedgerRewriteRecord {
  kind: "rewrite";
  file: string;
  before: string;
  after: string;
  byteOffset: number;
  linkKind: "wiki-path" | "md-path";
}

export interface LedgerCommitRecord {
  kind: "commit";
  applied: number;
  skipped: number;
}

export type LedgerRecord =
  | LedgerHeaderRecord
  | LedgerMoveRecord
  | LedgerRewriteRecord
  | LedgerCommitRecord;

// ---------------------------------------------------------------------------
// Ledger directory helpers
// ---------------------------------------------------------------------------

/** Absolute path to the organize ledger directory. */
export function ledgerDir(kbRoot: string): string {
  return path.join(kbRoot, ".kb-index", "organize");
}

/** Generate an ISO-safe timestamp string for use in filenames. */
function ledgerTimestamp(): string {
  // Replace colons and dots with dashes so filenames are valid on all platforms.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Absolute path to a new ledger file for this organize run. */
export function newLedgerPath(kbRoot: string): string {
  return path.join(ledgerDir(kbRoot), `${ledgerTimestamp()}.jsonl`);
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex hash of a file's raw bytes.
 * Used to detect user edits between dry-run and apply (spec edge case #7).
 */
export async function hashFile(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Append a single record to the ledger file as a JSONL line.
 * Creates the ledger directory if absent.
 */
export async function appendRecord(
  ledgerPath: string,
  record: LedgerRecord
): Promise<void> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(ledgerPath, JSON.stringify(record) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Parse a ledger JSONL file into an array of records.
 * Tolerates trailing newlines and blank lines (silently skipped).
 * Tolerates malformed lines (warns to stderr, continues — partial-write safety).
 */
export async function readLedger(ledgerPath: string): Promise<LedgerRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(ledgerPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const records: LedgerRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as LedgerRecord;
      records.push(record);
    } catch {
      // Silently skip malformed lines — partial-write safety (same policy as sidecar).
      process.stderr.write(`[organize/ledger] skipping malformed line: ${trimmed}\n`);
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

/** Absolute path to the organize lock file. */
export function lockPath(kbRoot: string): string {
  return path.join(ledgerDir(kbRoot), ".lock");
}

/**
 * Acquire the organize lock.
 *
 * 1. Check if .lock exists.
 * 2. If yes, read the PID. If the process is running (kill -0), throw — organize is in progress.
 *    If ESRCH (no such process), the lock is stale — remove it.
 * 3. Write the current PID to .lock.
 *
 * LOAD-BEARING: concurrent-safety is O(process, not thread) — this is sufficient
 * because Node is single-threaded and organize is a CLI tool (one process per terminal).
 * For true atomic cross-process mutual exclusion, use O_EXCL open; we accept a small
 * TOCTOU window as it's documented and rare enough in practice.
 *
 * @throws Error "organize in progress (PID X)" if another live process holds the lock.
 */
export async function acquireLock(kbRoot: string): Promise<void> {
  const lp = lockPath(kbRoot);
  await fs.mkdir(path.dirname(lp), { recursive: true });

  // Check for an existing lock.
  let existingPid: number | null = null;
  try {
    const content = await fs.readFile(lp, "utf8");
    existingPid = parseInt(content.trim(), 10);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // No lock file — proceed to acquire.
  }

  if (existingPid !== null && !Number.isNaN(existingPid)) {
    // Check if the process is still running.
    let processAlive = false;
    try {
      process.kill(existingPid, 0); // signal 0 = existence check only
      processAlive = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        // No such process — stale lock, remove it and proceed.
        processAlive = false;
      } else if ((err as NodeJS.ErrnoException).code === "EPERM") {
        // Process exists but we can't signal it (different user) — treat as alive.
        processAlive = true;
      } else {
        throw err;
      }
    }

    if (processAlive) {
      throw new Error(`organize in progress (PID ${existingPid})`);
    }

    // Stale lock — remove it.
    await fs.rm(lp, { force: true });
  }

  // Write our PID.
  await fs.writeFile(lp, String(process.pid), "utf8");
}

/**
 * Release the organize lock (remove .lock file).
 * Safe to call even if the lock file is already gone.
 */
export async function releaseLock(kbRoot: string): Promise<void> {
  const lp = lockPath(kbRoot);
  await fs.rm(lp, { force: true });
}

// ---------------------------------------------------------------------------
// Most-recent ledger finder
// ---------------------------------------------------------------------------

/**
 * Find the most recent ledger file that has NOT been marked undone.
 * Returns null if no eligible ledger exists.
 *
 * "Most recent" = lexicographically last among `*.jsonl` files excluding `*.undone.jsonl`.
 * Because the timestamp is ISO-formatted (with dashes), lexicographic order = chronological order.
 */
export async function findLatestLedger(kbRoot: string): Promise<string | null> {
  const dir = ledgerDir(kbRoot);
  let entries: string[];
  try {
    const dirEntries = await fs.readdir(dir);
    entries = dirEntries;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const eligible = entries
    .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".undone.jsonl"))
    .sort(); // lexicographic = chronological for ISO-timestamp filenames

  if (eligible.length === 0) return null;
  return path.join(dir, eligible[eligible.length - 1]);
}
