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
 *
 * Phase 2 (learnings pipeline): lock + hash helpers are now in src/core/ledger.ts.
 * The kbRoot-based wrappers below delegate to those shared helpers so that
 * organize's call sites remain unchanged (they pass kbRoot, not lockPath).
 */

import fs from "node:fs/promises";
import path from "node:path";

// Re-export shared isLockHeld for cross-feature R-6 guard.
export { isLockHeld, hashFile } from "../ledger";
import {
  acquireLock as sharedAcquireLock,
  releaseLock as sharedReleaseLock,
} from "../ledger";

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
// Lockfile — kbRoot-based wrappers (backward compat)
//
// organize.ts calls acquireLock(root) / releaseLock(root) where root is the
// KB root path. These wrappers compute the full lock path then delegate to
// the shared helpers in src/core/ledger.ts (which accept a full lockPath).
// LOAD-BEARING: do NOT change the signature here — organize.ts imports these.
// ---------------------------------------------------------------------------

/** Absolute path to the organize lock file. */
export function lockPath(kbRoot: string): string {
  return path.join(ledgerDir(kbRoot), ".lock");
}

/**
 * Acquire the organize lock.
 * Delegates to the shared acquireLock(lockPath) in src/core/ledger.ts.
 * LOAD-BEARING: error message must contain "organize in progress (PID X)" —
 * existing tests and CLI error paths match against this phrase.
 * @throws Error if another live process holds the lock.
 */
export async function acquireLock(kbRoot: string): Promise<void> {
  try {
    await sharedAcquireLock(lockPath(kbRoot));
  } catch (err) {
    // Re-throw with organize-specific wording so CLI / tests match "organize in progress".
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`organize in progress — ${msg}`);
  }
}

/**
 * Release the organize lock (remove .lock file).
 * Safe to call even if the lock file is already gone.
 */
export async function releaseLock(kbRoot: string): Promise<void> {
  await sharedReleaseLock(lockPath(kbRoot));
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
