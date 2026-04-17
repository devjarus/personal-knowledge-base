/**
 * sourceHashes.ts — Hashing helpers for learn pipeline idempotency.
 *
 * `hashSources(kbRoot, notes)` computes sorted SHA-256 hex array over source
 * note file bytes. Sorted so the hash is stable regardless of discovery order.
 *
 * `readExistingSummary(kbRoot, clusterPath)` parses any existing _summary.md
 * in the cluster folder and returns the idempotency fields needed for
 * status classification.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import matter from "gray-matter";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExistingSummaryInfo {
  /** Sorted SHA-256 hashes of source notes as recorded in the summary's frontmatter. */
  sourceHashes: string[];
  /**
   * Generator tier recorded in the summary's frontmatter `generator` field
   * (always "kb-learn@0.1.0" for summaries written by this tool).
   */
  generator: string;
  /**
   * Model field from frontmatter — "extractive" or "ollama:<tag>".
   * null when the field is absent (e.g. hand-crafted summaries).
   * This is the field used for idempotency comparisons (F2 fix).
   */
  model: string | null;
  /** SHA-256 of the current _summary.md file bytes (for R-5 user-edit detection). */
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex hash of a file's raw bytes.
 * Replicates the helper from organize/ledger.ts — Phase 2 will extract this
 * to src/core/ledger.ts and both modules will import from there.
 */
export async function hashBytes(buf: Buffer): Promise<string> {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Compute sorted SHA-256 hex hashes of all source note files.
 *
 * The array is sorted so that the same set of notes always produces the same
 * hash list regardless of discovery order (idempotency requirement FR-18/FR-19).
 *
 * @param kbRoot  Absolute path to the KB root.
 * @param notes   KB-relative paths of the source notes.
 * @returns       Sorted array of SHA-256 hex strings, one per source note.
 */
export async function hashSources(kbRoot: string, notes: string[]): Promise<string[]> {
  const hashes = await Promise.all(
    notes.map(async (relPath) => {
      const absPath = path.join(kbRoot, relPath);
      const buf = await fs.readFile(absPath);
      return crypto.createHash("sha256").update(buf).digest("hex");
    })
  );

  // Sort for stability — same set of notes always produces same sorted hash array.
  hashes.sort();
  return hashes;
}

/**
 * Read and parse an existing _summary.md in a cluster folder.
 *
 * Returns null if:
 *   - No _summary.md exists in the folder
 *   - The file doesn't have `type: cluster-summary` frontmatter
 *   - Frontmatter is missing required fields (tolerates partial data gracefully)
 *
 * @param kbRoot       Absolute path to the KB root.
 * @param clusterPath  KB-relative cluster folder path (e.g. "ideas/ml").
 */
export async function readExistingSummary(
  kbRoot: string,
  clusterPath: string
): Promise<ExistingSummaryInfo | null> {
  const summaryPath = path.join(kbRoot, clusterPath, "_summary.md");
  let raw: Buffer;
  try {
    raw = await fs.readFile(summaryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  // Parse frontmatter.
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw.toString("utf8"));
  } catch {
    // Malformed frontmatter — treat as absent.
    return null;
  }

  const fm = parsed.data;

  // Only treat as a generated summary if it has the type marker.
  if (fm.type !== "cluster-summary") return null;

  // Extract sourceHashes (tolerate missing field).
  const rawHashes = fm.sourceHashes;
  const sourceHashes: string[] = Array.isArray(rawHashes)
    ? rawHashes.filter((h): h is string => typeof h === "string")
    : [];

  // Extract generator tool name (e.g. "kb-learn@0.1.0").
  const generator = typeof fm.generator === "string" ? fm.generator : "";

  // Extract model field (e.g. "extractive", "ollama:llama3.2").
  // This is the field used for idempotency tier comparisons.
  // F2 fix: return null (not "") when missing so the ?? fallback in learn.ts
  // fires correctly — hand-crafted summaries without a model field should not
  // always be classified stale.
  const model = typeof fm.model === "string" ? fm.model : null;

  // Compute contentHash of the current file for R-5 user-edit detection.
  const contentHash = crypto.createHash("sha256").update(raw).digest("hex");

  return { sourceHashes, generator, model, contentHash };
}
