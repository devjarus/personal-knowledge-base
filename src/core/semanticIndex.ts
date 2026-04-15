/**
 * semanticIndex.ts — owns the JSONL embedding sidecar.
 *
 * Persists one JSON line per note at <KB_ROOT>/.kb-index/embeddings.jsonl.
 * Signature = `${mtimeMs}:${size}` — cheap stat-based staleness detection.
 *
 * Cache strategy: piggybacks on _notesCacheSignature(root) from fs.ts exactly
 * the way links.ts does. When the notes signature changes we know the KB changed
 * and we invalidate — no separate sidecar watch needed (R-5).
 *
 * Dependency direction: semanticIndex.ts → fs.ts, embeddings.ts only.
 * fs.ts does NOT import this file (prevented by T4's hook pattern).
 *
 * On module load, registers a hook in fs.ts so writeNote / deleteNote keep
 * the sidecar fresh without creating a circular dependency (T4).
 */

import fs from "node:fs/promises";
import path from "node:path";

import { kbRoot } from "./paths";
import { listNotes, _notesCacheSignature, _registerNotesChangeHook } from "./fs";
import { embedText, isEmbedderWarm, EMBEDDING_MODEL, EMBEDDING_DIM } from "./embeddings";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IndexRow {
  path: string;      // KB-relative
  sig: string;       // `${mtimeMs}:${size}`
  model: string;     // EMBEDDING_MODEL
  dim: number;       // EMBEDDING_DIM
  vec: number[];     // length === dim (plain array in JSON)
}

// ---------------------------------------------------------------------------
// Sidecar path
// ---------------------------------------------------------------------------

/** Absolute path to the sidecar JSONL for the current KB_ROOT. */
export function sidecarPath(): string {
  return path.join(kbRoot(), ".kb-index", "embeddings.jsonl");
}

// ---------------------------------------------------------------------------
// Module-scoped in-memory cache
//
// Keyed by kbRoot string. Invalidated when the listNotes signature changes,
// exactly like links.ts. The in-memory map is the authoritative source for
// queryTopK — no fs I/O per query once warm.
// ---------------------------------------------------------------------------

interface SemanticCache {
  /** The listNotes() signature when this cache was built. */
  notesSig: string;
  /** path → row */
  index: Map<string, IndexRow>;
}

const _cache = new Map<string, SemanticCache>();

/** Force-drop the in-memory cache. Tests only. */
export function _invalidateSemanticCache(): void {
  _cache.delete(kbRoot());
}

/** Allow tests to swap out the embedder function. */
let _embedFn: (text: string) => Promise<Float32Array> = embedText;
export function _setEmbedderForTests(fn: (text: string) => Promise<Float32Array>): void {
  _embedFn = fn;
}

// ---------------------------------------------------------------------------
// Sidecar I/O helpers
// ---------------------------------------------------------------------------

/**
 * Parse the JSONL sidecar file into a Map<path, IndexRow>.
 * Returns an empty map if the file is missing or empty — never throws on
 * absent sidecar (AC-7 fallback path).
 */
async function readSidecar(): Promise<Map<string, IndexRow>> {
  const sp = sidecarPath();
  const map = new Map<string, IndexRow>();
  let raw: string;
  try {
    raw = await fs.readFile(sp, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return map;
    throw err;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as IndexRow;
      if (row.path && row.sig && Array.isArray(row.vec)) {
        map.set(row.path, row);
      }
    } catch {
      // Silently skip malformed lines — partial write recovery.
    }
  }
  return map;
}

/**
 * Atomically write a Map<path, IndexRow> to the sidecar JSONL.
 * Writes to .tmp file then renames — never leaves a partial file (T3 spec).
 */
async function writeSidecar(index: Map<string, IndexRow>): Promise<void> {
  const sp = sidecarPath();
  const dir = path.dirname(sp);
  await fs.mkdir(dir, { recursive: true });

  const tmp = `${sp}.tmp`;
  const lines: string[] = [];
  for (const row of index.values()) {
    lines.push(JSON.stringify(row));
  }
  await fs.writeFile(tmp, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  await fs.rename(tmp, sp);
}

/**
 * Compute per-note signature from stat — cheap, no file read (R-4).
 * Format: `${mtimeMs}:${size}` matching fs.ts computeSignature style.
 */
async function noteSig(absPath: string): Promise<string> {
  const st = await fs.stat(absPath);
  return `${st.mtimeMs}:${st.size}`;
}

// ---------------------------------------------------------------------------
// Public API: load
// ---------------------------------------------------------------------------

/**
 * Load (or return cached) the full index map path → IndexRow.
 * Missing sidecar → empty map (no throw — AC-7 fallback path).
 *
 * Cache is keyed on kbRoot + notesCacheSignature. If the notes signature
 * hasn't changed since last load, we return the in-memory map directly.
 */
export async function loadIndex(): Promise<Map<string, IndexRow>> {
  const root = kbRoot();

  // Trigger a listNotes() to populate the notes cache signature.
  await listNotes();
  const notesSig = _notesCacheSignature(root) ?? "";

  const cached = _cache.get(root);
  if (cached && cached.notesSig === notesSig) {
    return cached.index;
  }

  // Cache miss — read sidecar from disk.
  const index = await readSidecar();
  _cache.set(root, { notesSig, index });
  return index;
}

// ---------------------------------------------------------------------------
// Public API: rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild the full index from scratch over the current listNotes().
 * Re-embeds every note, prints per-note progress via onProgress callback.
 * Writes the sidecar atomically. Returns stats.
 */
export async function rebuildIndex(
  onProgress?: (done: number, total: number, path: string) => void,
): Promise<{ indexed: number; skipped: number; durationMs: number }> {
  const t0 = Date.now();
  const root = kbRoot();
  const notes = await listNotes();
  const total = notes.length;
  const newIndex = new Map<string, IndexRow>();
  let indexed = 0;
  let skipped = 0;

  for (let i = 0; i < notes.length; i++) {
    const s = notes[i];
    const absPath = path.join(root, s.path);
    try {
      const sig = await noteSig(absPath);
      const body = s.preview; // preview is already in memory from listNotes
      // For embeddings, use preview as proxy only for speed; but we want
      // full body text for quality. Read it here.
      const { readNote } = await import("./fs");
      const note = await readNote(s.path);
      const vec = await _embedFn(note.body || note.raw);
      const row: IndexRow = {
        path: s.path,
        sig,
        model: EMBEDDING_MODEL,
        dim: EMBEDDING_DIM,
        vec: Array.from(vec),
      };
      newIndex.set(s.path, row);
      indexed++;
    } catch (err) {
      // Skip this note on embed error — don't abort the whole reindex.
      process.stderr.write(
        `[semanticIndex] skipping ${s.path}: ${err instanceof Error ? err.message : String(err)}\n`
      );
      skipped++;
    }
    onProgress?.(i + 1, total, s.path);
  }

  await writeSidecar(newIndex);
  // Invalidate + repopulate in-memory cache.
  await listNotes();
  const notesSig = _notesCacheSignature(root) ?? "";
  _cache.set(root, { notesSig, index: newIndex });

  return { indexed, skipped, durationMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Public API: incremental refresh
// ---------------------------------------------------------------------------

/**
 * Incremental update: diff current listNotes() against the in-memory index.
 * Re-embeds rows whose sig changed or are missing, drops rows for deleted notes.
 * Persists to disk. No-op if index matches notes exactly.
 */
export async function refreshIndex(): Promise<{ added: number; updated: number; removed: number }> {
  const root = kbRoot();
  const notes = await listNotes();
  const index = await loadIndex();

  let added = 0;
  let updated = 0;
  let removed = 0;

  // Compute which notes are new or stale.
  const currentPaths = new Set<string>();
  for (const s of notes) {
    currentPaths.add(s.path);
    const absPath = path.join(root, s.path);
    let sig: string;
    try {
      sig = await noteSig(absPath);
    } catch {
      // Note disappeared mid-walk — skip.
      continue;
    }

    const existing = index.get(s.path);
    if (existing && existing.sig === sig) {
      // Unchanged — keep.
      continue;
    }

    // New or stale — embed.
    try {
      const { readNote } = await import("./fs");
      const note = await readNote(s.path);
      const vec = await _embedFn(note.body || note.raw);
      const row: IndexRow = {
        path: s.path,
        sig,
        model: EMBEDDING_MODEL,
        dim: EMBEDDING_DIM,
        vec: Array.from(vec),
      };
      if (existing) {
        updated++;
      } else {
        added++;
      }
      index.set(s.path, row);
    } catch (err) {
      process.stderr.write(
        `[semanticIndex] skipping ${s.path}: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  // Drop rows for deleted notes.
  for (const p of index.keys()) {
    if (!currentPaths.has(p)) {
      index.delete(p);
      removed++;
    }
  }

  // Persist only if something changed.
  if (added > 0 || updated > 0 || removed > 0) {
    await writeSidecar(index);
    // Update cache key.
    await listNotes();
    const notesSig = _notesCacheSignature(root) ?? "";
    _cache.set(root, { notesSig, index });
  }

  return { added, updated, removed };
}

// ---------------------------------------------------------------------------
// Public API: single-note upsert / remove (used by the writeNote hook)
// ---------------------------------------------------------------------------

/**
 * Upsert a single note's embedding (used by the writeNote hook in T4).
 * Reads the note, embeds it, and writes the updated sidecar atomically.
 */
export async function upsertOne(relPath: string): Promise<void> {
  const root = kbRoot();
  const index = await loadIndex();
  const absPath = path.join(root, relPath);
  const sig = await noteSig(absPath);

  const { readNote } = await import("./fs");
  const note = await readNote(relPath);
  const vec = await _embedFn(note.body || note.raw);

  index.set(relPath, {
    path: relPath,
    sig,
    model: EMBEDDING_MODEL,
    dim: EMBEDDING_DIM,
    vec: Array.from(vec),
  });

  await writeSidecar(index);
  // Update cache with latest notesSig.
  await listNotes();
  const notesSig = _notesCacheSignature(root) ?? "";
  _cache.set(root, { notesSig, index });
}

/**
 * Rename the sidecar key for a moved note WITHOUT re-embedding.
 *
 * Called by applyOrganizePlan / undoLastOrganize (organize.ts Phase 2).
 * The embedding vector is unchanged — only the path key in the sidecar
 * needs updating (spec risk #6: short-circuit re-embed).
 *
 * If oldPath is not in the index, this is a no-op (the note may not have
 * been embedded yet — that's fine, undo/apply still works on the file level).
 */
export async function _renameSidecarPath(
  oldPath: string,
  newPath: string,
): Promise<void> {
  const root = kbRoot();
  const index = await loadIndex();
  const row = index.get(oldPath);
  if (!row) return; // no embedding row — nothing to rename
  index.delete(oldPath);
  index.set(newPath, { ...row, path: newPath });
  await writeSidecar(index);
  // Refresh cache key so subsequent loadIndex() calls see the updated map.
  await listNotes();
  const notesSig = _notesCacheSignature(root) ?? "";
  _cache.set(root, { notesSig, index });
}

/**
 * Drop a single note's row (used by the deleteNote hook in T4).
 * Cheap: just removes a row from the in-memory map and rewrites sidecar.
 */
export async function removeOne(relPath: string): Promise<void> {
  const root = kbRoot();
  const index = await loadIndex();
  if (!index.has(relPath)) return; // already gone
  index.delete(relPath);
  await writeSidecar(index);
  await listNotes();
  const notesSig = _notesCacheSignature(root) ?? "";
  _cache.set(root, { notesSig, index });
}

// ---------------------------------------------------------------------------
// Public API: cosine query
// ---------------------------------------------------------------------------

/**
 * Query: given a pre-computed unit-normalized query vector, return the top-K
 * notes by cosine similarity (= dot product for unit vecs).
 *
 * Pure function over the in-memory index — no fs I/O. O(N*D) where N ≤ 1000
 * and D = 384: <1ms per spec NG-1.
 */
export function queryTopK(
  qVec: Float32Array,
  k: number,
  currentIndex?: Map<string, IndexRow>,
): Array<{ path: string; cosine: number }> {
  const index = currentIndex ?? (_cache.get(kbRoot())?.index ?? new Map());
  const scores: Array<{ path: string; cosine: number }> = [];

  for (const row of index.values()) {
    // Dot product over unit-normalized vectors = cosine similarity.
    let dot = 0;
    const v = row.vec;
    for (let i = 0; i < qVec.length; i++) {
      dot += qVec[i] * v[i];
    }
    scores.push({ path: row.path, cosine: dot });
  }

  scores.sort((a, b) => b.cosine - a.cosine);
  return scores.slice(0, k);
}

// ---------------------------------------------------------------------------
// T4: Register the notes-change hook on module load.
//
// This runs once when semanticIndex.ts is first imported. The hook is called
// fire-and-forget by writeNote / deleteNote in fs.ts (no circular dep — fs.ts
// imports nothing from this module; the callback direction is reversed).
//
// The handler intentionally does NOT await its work (the hook is fire-and-forget)
// but uses an IIFE to run async code without blocking the write path.
// ---------------------------------------------------------------------------

_registerNotesChangeHook((event, relPath) => {
  if (event === "write") {
    // Only embed on the write path if the model is already warm — keeps NFR-3.
    if (!isEmbedderWarm()) return;
    // Async IIFE — fire-and-forget. Errors are logged but do NOT break writeNote.
    void (async () => {
      try {
        await upsertOne(relPath);
      } catch (err) {
        process.stderr.write(
          `[semanticIndex] hook: failed to upsert ${relPath}: ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      }
    })();
  } else if (event === "delete") {
    // Remove is cheap (drop row + rewrite sidecar). Always do it.
    void (async () => {
      try {
        await removeOne(relPath);
      } catch (err) {
        process.stderr.write(
          `[semanticIndex] hook: failed to remove ${relPath}: ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      }
    })();
  }
});

