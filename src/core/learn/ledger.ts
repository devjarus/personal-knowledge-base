/**
 * ledger.ts — Learn-specific ledger record types + writers.
 *
 * Ledger lives at: <kbRoot>/.kb-index/learn/<ISO-timestamp>.jsonl
 * Lock lives at:   <kbRoot>/.kb-index/learn/.lock
 *
 * Parallel structure to organize/ledger.ts; completely separate so that
 * `kb learn --undo` never accidentally reverses organize operations.
 *
 * Record shapes (one JSON object per line):
 *
 *   { "kind": "header", "generatedAt": string, "mode": "full"|"scoped", "generator": string }
 *   { "kind": "learning-write", "path": string, "contentHash": string, "generator": string,
 *     "model": string|null, "sourceHashes": string[],
 *     "previousContentHash": string|null, "previousContent": string|null }
 *   { "kind": "commit", "written": number, "skipped": number }
 *
 * Writer: appends with fs.appendFile (crash-recovery safe — partial ledger
 * readable line-by-line; undoLastLearn tolerates orphan records).
 */

import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

export interface LearnLedgerHeaderRecord {
  kind: "header";
  generatedAt: string;
  mode: "full" | "scoped";
  generator: string; // e.g. "kb-learn@0.1.0"
}

export interface LearnLedgerWriteRecord {
  kind: "learning-write";
  /** KB-relative path of the written summary file. */
  path: string;
  /** SHA-256 of the file bytes AS WRITTEN by this run (for R-5 edit detection). */
  contentHash: string;
  /** Generator tier used: "extractive" or "ollama". */
  generator: string;
  /** Model value: "extractive" or "ollama:<tag>". */
  model: string | null;
  /** Sorted SHA-256 hashes of the source notes at write time. */
  sourceHashes: string[];
  /** SHA-256 of the previous summary file (if this was an overwrite; null for new files). */
  previousContentHash: string | null;
  /**
   * Base64-encoded raw bytes of the previous summary file.
   * Present for overwrites so undo can restore byte-for-byte.
   * null for new file writes — undo will moveToTrash instead.
   */
  previousContent: string | null;
}

export interface LearnLedgerCommitRecord {
  kind: "commit";
  written: number;
  skipped: number;
}

export type LearnLedgerRecord =
  | LearnLedgerHeaderRecord
  | LearnLedgerWriteRecord
  | LearnLedgerCommitRecord;

// ---------------------------------------------------------------------------
// Directory + path helpers
// ---------------------------------------------------------------------------

/** Absolute path to the learn ledger directory. */
export function learnLedgerDir(kbRoot: string): string {
  return path.join(kbRoot, ".kb-index", "learn");
}

/** Absolute path to the learn lock file. */
export function learnLockPath(kbRoot: string): string {
  return path.join(learnLedgerDir(kbRoot), ".lock");
}

/** Generate an ISO-safe timestamp string for use in filenames. */
function ledgerTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Absolute path to a new ledger file for this learn run. */
export function newLearnLedgerPath(kbRoot: string): string {
  return path.join(learnLedgerDir(kbRoot), `${ledgerTimestamp()}.jsonl`);
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Append a single record to a learn ledger JSONL file.
 * Creates the ledger directory if absent.
 */
export async function appendLearnRecord(
  ledgerPath: string,
  record: LearnLedgerRecord
): Promise<void> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(ledgerPath, JSON.stringify(record) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Parse a learn ledger JSONL file into an array of records.
 * Tolerates trailing newlines, blank lines, and malformed lines (partial-write
 * safety — undoLastLearn must tolerate orphan records from a crashed apply run).
 */
export async function readLearnLedger(ledgerPath: string): Promise<LearnLedgerRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(ledgerPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const records: LearnLedgerRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as LearnLedgerRecord;
      records.push(record);
    } catch {
      // Silently skip malformed lines — partial-write safety.
      process.stderr.write(`[learn/ledger] skipping malformed line: ${trimmed}\n`);
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Latest ledger finder
// ---------------------------------------------------------------------------

/**
 * Find the most recent learn ledger file that has NOT been marked undone.
 * Returns null if no eligible ledger exists.
 *
 * "Most recent" = lexicographically last among `*.jsonl` files excluding
 * `*.undone.jsonl`. ISO-timestamp filenames make lex order = chronological.
 */
export async function findLatestLearnLedger(kbRoot: string): Promise<string | null> {
  const dir = learnLedgerDir(kbRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const eligible = entries
    .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".undone.jsonl"))
    .sort(); // lex = chronological for ISO-timestamp filenames

  if (eligible.length === 0) return null;
  return path.join(dir, eligible[eligible.length - 1]);
}
