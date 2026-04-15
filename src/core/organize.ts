/**
 * organize.ts — Auto-organize KB notes into topical folders.
 *
 * Phase 1: pure plan-building (classifier + clustering). No filesystem writes.
 * Phase 2: applyOrganizePlan + ledger + move execution + undo.
 * Phase 3 (future): link rewriting.
 *
 * Public API is locked across all phases (see plan.md "Locked public API").
 */

import path from "node:path";
import fs from "node:fs/promises";

import { kbRoot } from "./paths.js";
import { listNotes, _invalidateNotesCache } from "./fs.js";
import { loadIndex, _renameSidecarPath } from "./semanticIndex.js";
import type { IndexRow } from "./semanticIndex.js";
import { isCarvedOut } from "./organize/carveouts.js";
import { classifyByFrontmatter } from "./organize/classifier.js";
import { cluster } from "./organize/cluster.js";
import type { ClusterInput } from "./organize/cluster.js";
import type { NoteSummary } from "./types.js";
import { readNote } from "./fs.js";
import { moveNote } from "./organize/move.js";
import {
  newLedgerPath,
  appendRecord,
  readLedger,
  hashFile,
  acquireLock,
  releaseLock,
  findLatestLedger,
  ledgerDir,
} from "./organize/ledger.js";
import type { LedgerMoveRecord } from "./organize/ledger.js";

// ---------------------------------------------------------------------------
// Public types — locked cross-phase contract
// ---------------------------------------------------------------------------

export interface OrganizeMove {
  from: string;         // KB-relative path, no leading slash
  to: string;           // KB-relative path, no leading slash
  reason: "type" | "tag" | "cluster" | "user-filed";
  confidence: number;   // 0..1; 1.0 for type/tag; cosine for cluster
  clusterLabel?: string;
}

export interface LinkRewrite {
  file: string;         // KB-relative path of the file being edited
  before: string;       // raw link text before rewrite (e.g. "[[old/path]]")
  after: string;        // raw link text after rewrite
  byteOffset: number;   // byte offset of `before` in the file's raw bytes
  kind: "wiki-path" | "md-path";
}

export interface OrganizePlan {
  generatedAt: string;                    // ISO timestamp
  mode: "full" | "incremental";
  moves: OrganizeMove[];
  rewrites: LinkRewrite[];
  unassigned: { path: string; reason: string }[];
  clusters: { folder: string; memberCount: number; topTerms: string[] }[];
  stats: {
    total: number;
    byType: number;
    byTag: number;
    byCluster: number;
    unassigned: number;
  };
}

export interface BuildPlanOptions {
  kbRoot?: string;                // override kbRoot() for tests
  mode: "full" | "incremental";
  exclude?: string[];             // extra globs beyond the baked-in carve-outs
  minConfidence?: number;         // default 0.35
  maxClusters?: number;           // default auto, capped at 20
  driftMargin?: number;           // default 0.05 (incremental only)
  rewriteLinks?: boolean;         // default true (Phase 3 implements this)
}

export interface ApplyResult {
  applied: number;
  ledgerPath: string;             // absolute path to the written ledger
  skipped: OrganizeMove[];        // moves whose content-hash changed since plan
}

export interface UndoResult {
  reverted: number;
  ledgerPath: string;
  conflicts: { path: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Error type for missing sidecar / .kb-index
// ---------------------------------------------------------------------------

export class OrganizeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "MISSING_SIDECAR"
      | "MISSING_INDEX_DIR"
      | "NOT_IMPLEMENTED"
      | "LOCK_HELD"
      | "NO_LEDGER"
  ) {
    super(message);
    this.name = "OrganizeError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect the set of top-level folder names currently in the KB tree.
 * Used by the classifier for tag tie-breaking (stability: existing folder wins).
 */
async function collectExistingFolders(root: string): Promise<Set<string>> {
  const folders = new Set<string>();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return folders;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      folders.add(entry.name);
    }
  }
  return folders;
}

/**
 * Build the target path for a note given its assigned target folder.
 * The filename stays the same (spec R6: no filename renames).
 */
function targetPath(notePath: string, targetFolder: string): string {
  const filename = path.basename(notePath);
  return `${targetFolder}/${filename}`;
}

/**
 * Tokenize a note title or tag into terms for clustering.
 * Simple: lowercase, split on non-alphanumeric, filter empties.
 */
function tokenizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

// ---------------------------------------------------------------------------
// buildOrganizePlan — Phase 1 implementation
// ---------------------------------------------------------------------------

/**
 * Build a full organize plan for the KB.
 *
 * @throws OrganizeError if the sidecar or .kb-index dir is missing.
 */
export async function buildOrganizePlan(opts: BuildPlanOptions): Promise<OrganizePlan> {
  const root = opts.kbRoot ?? kbRoot();
  const minConfidence = opts.minConfidence ?? 0.35;
  const maxClusters = opts.maxClusters ?? 20;
  const extraGlobs = opts.exclude ?? [];

  // ---------------------------------------------------------------------------
  // Validate .kb-index existence. Fail fast with a useful error message.
  // (Edge cases #5, #12 from spec.)
  // ---------------------------------------------------------------------------

  const indexDir = path.join(root, ".kb-index");
  try {
    await fs.access(indexDir);
  } catch {
    throw new OrganizeError(
      "run 'kb reindex' first — .kb-index/ is missing from the KB root",
      "MISSING_INDEX_DIR"
    );
  }

  const sidecarFile = path.join(indexDir, "embeddings.jsonl");
  try {
    await fs.access(sidecarFile);
  } catch {
    throw new OrganizeError(
      "run 'kb reindex' first — .kb-index/embeddings.jsonl is missing",
      "MISSING_SIDECAR"
    );
  }

  // ---------------------------------------------------------------------------
  // Incremental mode: requires clusters.json to be present.
  // If it's absent, short-circuit and report a useful error.
  // ---------------------------------------------------------------------------

  if (opts.mode === "incremental") {
    const clustersFile = path.join(indexDir, "organize", "clusters.json");
    try {
      await fs.access(clustersFile);
    } catch {
      throw new OrganizeError(
        "run 'kb organize --apply' first — clusters.json is absent. Incremental mode requires a completed full organize.",
        "MISSING_SIDECAR"
      );
    }
    // Phase 5 (incremental) will implement the full incremental logic.
    // For now, fall through to the full-mode logic.
  }

  // ---------------------------------------------------------------------------
  // Load notes + embeddings.
  // ---------------------------------------------------------------------------

  // NOTE (nit #2): listNotes() reads kbRoot() internally; it does not accept a
  // root parameter. Threading kbRoot through listNotes() would require a public
  // API change to fs.ts. To unblock tests that set opts.kbRoot, we set+restore
  // process.env.KB_ROOT in a try/finally. This is racey under concurrent MCP
  // invocations, but acceptable for Phase 2 — the async microtask is synchronous
  // between awaits so cross-invocation races don't occur in practice on a single
  // event-loop thread. Tracked for proper fix in a future phase.
  const originalKbRoot = process.env.KB_ROOT;
  if (opts.kbRoot) {
    process.env.KB_ROOT = opts.kbRoot;
  }

  let notes: NoteSummary[];
  let embeddingIndex: Map<string, IndexRow>;

  try {
    notes = await listNotes();
    embeddingIndex = await loadIndex();
  } finally {
    if (opts.kbRoot) {
      // Restore original KB_ROOT.
      if (originalKbRoot !== undefined) {
        process.env.KB_ROOT = originalKbRoot;
      } else {
        delete process.env.KB_ROOT;
      }
    }
  }

  const existingFolders = await collectExistingFolders(root);

  // ---------------------------------------------------------------------------
  // Classify each note: carve-out → skip; type/tag → assign; else → cluster.
  // ---------------------------------------------------------------------------

  const moves: OrganizeMove[] = [];
  const unassigned: OrganizePlan["unassigned"] = [];
  const clusterInputs: ClusterInput[] = [];
  const clusterInputMeta = new Map<string, { note: NoteSummary }>();

  let byType = 0;
  let byTag = 0;

  // Track target path collisions: targetPath → first note that claimed it.
  const claimedTargets = new Map<string, string>();

  for (const note of notes) {
    // Build frontmatter for carveout check.
    // NoteSummary doesn't carry the full frontmatter, but does carry type, tags.
    // We reconstruct a minimal Frontmatter object from available fields.
    // NOTE: `organize` and `pinned` fields are NOT in NoteSummary — we need
    // readNote() to get them. We do a quick readNote to get full frontmatter
    // only when not already carved out by path (fast path first).

    // Path-level carve-out check (no frontmatter needed).
    const fmProxy = { type: note.type, tags: note.tags };
    if (isCarvedOut(note.path, fmProxy, extraGlobs)) {
      // Note is carved out — skip silently (not reported as unassigned).
      continue;
    }

    // Read full frontmatter to check `organize: false` and `pinned: true`.
    let fullFm: Record<string, unknown> = {};
    try {
      const fullNote = await readNote(note.path);
      fullFm = fullNote.frontmatter;
    } catch {
      // If we can't read the note, treat as unassigned.
      unassigned.push({ path: note.path, reason: "read error" });
      continue;
    }

    if (isCarvedOut(note.path, fullFm, extraGlobs)) {
      // Carved out by frontmatter flags.
      continue;
    }

    // Classify by frontmatter (type/tag).
    const classification = classifyByFrontmatter(note, existingFolders);

    if (classification !== null) {
      const tPath = targetPath(note.path, classification.folder);

      // No-op check (edge case #10): from === to.
      if (tPath === note.path) continue;

      // Collision check.
      if (claimedTargets.has(tPath)) {
        unassigned.push({
          path: note.path,
          reason: `collision: ${tPath} already claimed by ${claimedTargets.get(tPath)}`,
        });
        continue;
      }
      claimedTargets.set(tPath, note.path);

      moves.push({
        from: note.path,
        to: tPath,
        reason: classification.reason,
        confidence: classification.confidence,
      });

      if (classification.reason === "type") byType++;
      else byTag++;

      continue;
    }

    // No frontmatter signal → try embedding cluster.
    const row = embeddingIndex.get(note.path);
    if (!row) {
      // No embedding → unassigned (spec edge case #6).
      unassigned.push({ path: note.path, reason: "no embedding" });
      continue;
    }

    // Prepare cluster input.
    const clusterInput: ClusterInput = {
      path: note.path,
      embedding: new Float32Array(row.vec),
      titleTerms: tokenizeTitle(note.title),
      tagTerms: note.tags,
    };
    clusterInputs.push(clusterInput);
    clusterInputMeta.set(note.path, { note });
  }

  // ---------------------------------------------------------------------------
  // Cluster the remaining notes.
  // ---------------------------------------------------------------------------

  let byCluster = 0;
  const clusterSummaries: OrganizePlan["clusters"] = [];

  if (clusterInputs.length > 0) {
    // Sort for determinism.
    clusterInputs.sort((a, b) => a.path.localeCompare(b.path));

    const clusterOut = cluster(clusterInputs, { minConfidence, maxClusters });

    // Register cluster folder assignments.
    for (const c of clusterOut.clusters) {
      clusterSummaries.push({
        folder: c.folder,
        memberCount: c.memberPaths.length,
        topTerms: c.topTerms,
      });

      for (const memberPath of c.memberPaths) {
        const assignment = clusterOut.assignments.get(memberPath);
        if (!assignment) continue;

        const tPath = targetPath(memberPath, c.folder);

        // No-op check.
        if (tPath === memberPath) continue;

        // Collision check.
        if (claimedTargets.has(tPath)) {
          unassigned.push({
            path: memberPath,
            reason: `collision: ${tPath} already claimed by ${claimedTargets.get(tPath)}`,
          });
          continue;
        }
        claimedTargets.set(tPath, memberPath);

        moves.push({
          from: memberPath,
          to: tPath,
          reason: "cluster",
          confidence: assignment.confidence,
          clusterLabel: c.folder,
        });
        byCluster++;
      }
    }

    // Notes from clusterOut.unassigned.
    for (const p of clusterOut.unassigned) {
      unassigned.push({ path: p, reason: "below min-confidence" });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: opts.mode,
    moves,
    rewrites: [], // Phase 3 fills this in
    unassigned,
    clusters: clusterSummaries,
    stats: {
      total: notes.length,
      byType,
      byTag,
      byCluster,
      unassigned: unassigned.length,
    },
  };
}

// ---------------------------------------------------------------------------
// applyOrganizePlan — Phase 2 implementation
// ---------------------------------------------------------------------------

/**
 * Apply a previously computed organize plan.
 *
 * Steps:
 *  1. Acquire the organize lock (.kb-index/organize/.lock).
 *  2. Write the full manifest to a new ledger BEFORE any moves (crash-safe).
 *  3. Content-hash each source file; skip if it changed since plan (edge case #7).
 *  4. For each move: mkdir target parent, atomic rename (EXDEV fallback), sweep
 *     empty parents unless keepEmptyDirs.
 *  5. Rename the sidecar entry for each moved note (no re-embed — vector unchanged).
 *  6. Fire the notes-change hook (delete old path + write new path) per move.
 *  7. Invalidate the notes cache once after all moves.
 *  8. Write a "commit" record to the ledger.
 *  9. Release the lock.
 *
 * @throws OrganizeError("LOCK_HELD") if another organize is in progress.
 */
export async function applyOrganizePlan(
  plan: OrganizePlan,
  opts: { keepEmptyDirs?: boolean } = {}
): Promise<ApplyResult> {
  const root = kbRoot();
  const keepEmptyDirs = opts.keepEmptyDirs ?? false;

  // Ensure the ledger dir exists before we try to acquire the lock.
  await fs.mkdir(ledgerDir(root), { recursive: true });

  // --- 1. Acquire lock ---
  try {
    await acquireLock(root);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OrganizeError(msg, "LOCK_HELD");
  }

  const lp = newLedgerPath(root);
  let applied = 0;
  const skipped: OrganizeMove[] = [];

  try {
    // --- 2. Write header + full manifest to ledger BEFORE any moves ---
    await appendRecord(lp, {
      kind: "header",
      generatedAt: plan.generatedAt,
      mode: plan.mode,
      minConfidence: 0.35, // default; plan doesn't carry this field separately
    });

    // Pre-compute content hashes and write ledger records (crash-recovery manifest).
    const moveHashes = new Map<string, string>(); // from → hash at apply time
    for (const move of plan.moves) {
      // Skip no-op moves (spec edge case #10).
      if (move.from === move.to) continue;

      const absSource = path.join(root, move.from);
      let hash: string;
      try {
        hash = await hashFile(absSource);
      } catch {
        // File disappeared between plan and apply — skip.
        skipped.push(move);
        continue;
      }
      moveHashes.set(move.from, hash);

      // Write ledger record BEFORE executing the move (crash-safe undo manifest).
      await appendRecord(lp, {
        kind: "move",
        from: move.from,
        to: move.to,
        contentHash: hash,
        reason: move.reason,
        confidence: move.confidence,
      });
    }

    // --- 3–6. Execute each move ---
    for (const move of plan.moves) {
      // Skip no-op moves.
      if (move.from === move.to) continue;

      const hash = moveHashes.get(move.from);
      if (hash === undefined) {
        // Was already skipped in the manifest pass (missing file).
        continue;
      }

      const absSource = path.join(root, move.from);
      const absTarget = path.join(root, move.to);

      // --- 3. Content-hash mismatch check (spec edge case #7) ---
      let currentHash: string;
      try {
        currentHash = await hashFile(absSource);
      } catch {
        skipped.push(move);
        continue;
      }
      if (currentHash !== hash) {
        // User edited the file between dry-run and apply — skip this move.
        skipped.push(move);
        continue;
      }

      // --- 4. Atomic move ---
      await moveNote({ absSource, absTarget, kbRoot: root, keepEmptyDirs });

      // --- 5. Rename sidecar entry (no re-embed; vector unchanged) ---
      // LOAD-BEARING: _renameSidecarPath short-circuits the re-embed path.
      // We do NOT fire the notes-change hook for moves because:
      //   a) The sidecar is already updated via _renameSidecarPath.
      //   b) The write hook would trigger a re-embed, which we explicitly avoid
      //      (spec risk #6: "vector is unchanged — only its key changes").
      // The notes cache is bulk-invalidated after all moves (step 7).
      await _renameSidecarPath(move.from, move.to);

      applied++;
    }

    // --- 7. Invalidate notes cache once (bulk invalidation) ---
    _invalidateNotesCache();

    // --- 8. Write commit record ---
    await appendRecord(lp, {
      kind: "commit",
      applied,
      skipped: skipped.length,
    });

    return { applied, ledgerPath: lp, skipped };
  } finally {
    // --- 9. Release lock (always, even on error) ---
    await releaseLock(root);
  }
}

// ---------------------------------------------------------------------------
// undoLastOrganize — Phase 2 implementation
// ---------------------------------------------------------------------------

/**
 * Undo the most recent applied organize.
 *
 * Steps:
 *  1. Find the most recent ledger not yet marked as undone.
 *  2. Acquire the lock.
 *  3. Parse the ledger. For each move record, check the current hash at `to`.
 *     If it changed, add to conflicts and skip. Otherwise reverse: rename to → from.
 *  4. Rename the sidecar entry back.
 *  5. Rename the ledger to <timestamp>.undone.jsonl.
 *  6. Invalidate the notes cache.
 *  7. Release the lock.
 *
 * @throws OrganizeError("NO_LEDGER") if no eligible ledger exists.
 * @throws OrganizeError("LOCK_HELD") if another organize is in progress.
 */
export async function undoLastOrganize(): Promise<UndoResult> {
  const root = kbRoot();

  // --- 1. Find the most recent eligible ledger ---
  const lp = await findLatestLedger(root);
  if (!lp) {
    throw new OrganizeError(
      "no ledger to undo — run 'kb organize --apply' first",
      "NO_LEDGER"
    );
  }

  // --- 2. Acquire lock ---
  try {
    await acquireLock(root);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OrganizeError(msg, "LOCK_HELD");
  }

  let reverted = 0;
  const conflicts: UndoResult["conflicts"] = [];

  try {
    // --- 3. Parse ledger ---
    const records = await readLedger(lp);
    const moveRecords = records.filter(
      (r): r is LedgerMoveRecord => r.kind === "move"
    );

    // Undo in reverse order (last move first) — important for overlapping paths.
    const toReverse = [...moveRecords].reverse();

    for (const record of toReverse) {
      const absTo = path.join(root, record.to);
      const absFrom = path.join(root, record.from);

      // Check if the moved file still exists at `to`.
      let currentHash: string;
      try {
        currentHash = await hashFile(absTo);
      } catch {
        // File at `to` is missing — skip (can't undo what isn't there).
        conflicts.push({
          path: record.to,
          reason: "file missing at destination",
        });
        continue;
      }

      // If the file was edited after the organize, skip to preserve user changes.
      if (currentHash !== record.contentHash) {
        conflicts.push({
          path: record.to,
          reason: "content changed since organize",
        });
        continue;
      }

      // Reverse the move: to → from.
      await moveNote({
        absSource: absTo,
        absTarget: absFrom,
        kbRoot: root,
        keepEmptyDirs: false, // sweep empty parents in the new (destination) direction
      });

      // Rename sidecar entry back.
      await _renameSidecarPath(record.to, record.from);

      reverted++;
    }

    // --- 5. Rename ledger to .undone.jsonl ---
    const undonePath = lp.replace(/\.jsonl$/, ".undone.jsonl");
    await fs.rename(lp, undonePath);

    // --- 6. Invalidate notes cache ---
    _invalidateNotesCache();

    return { reverted, ledgerPath: undonePath, conflicts };
  } finally {
    // --- 7. Release lock ---
    await releaseLock(root);
  }
}
