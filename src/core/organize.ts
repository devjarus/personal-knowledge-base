/**
 * organize.ts — Auto-organize KB notes into topical folders.
 *
 * Phase 1: pure plan-building (classifier + clustering). No filesystem writes.
 * Phase 2 (future): applyOrganizePlan + ledger + move execution.
 * Phase 3 (future): link rewriting.
 *
 * Public API is locked across all phases (see plan.md "Locked public API").
 */

import path from "node:path";
import fs from "node:fs/promises";

import { kbRoot } from "./paths.js";
import { listNotes } from "./fs.js";
import { loadIndex } from "./semanticIndex.js";
import type { IndexRow } from "./semanticIndex.js";
import { isCarvedOut } from "./organize/carveouts.js";
import { classifyByFrontmatter } from "./organize/classifier.js";
import { cluster } from "./organize/cluster.js";
import type { ClusterInput } from "./organize/cluster.js";
import type { NoteSummary } from "./types.js";

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
    public readonly code: "MISSING_SIDECAR" | "MISSING_INDEX_DIR" | "NOT_IMPLEMENTED"
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

  // Temporarily set KB_ROOT to the provided root if it differs, for listNotes().
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
    // (The fs.ts listNotes doesn't expose full frontmatter, so we synthesize.)
    // NOTE: `organize` and `pinned` fields are NOT in NoteSummary — we'd need
    // readNote() to get them. For Phase 1, we only check dotfiles + folder
    // carve-outs + type/tags. The `organize: false` and `pinned: true` checks
    // will operate on whatever the full frontmatter loader can provide.
    // To avoid per-note file reads (perf), we check them via the raw sidecar
    // approach only if the note is in scope. For correctness, we do a quick
    // readNote to get full frontmatter only when not already carved out by path.

    // Fast path: path-based carve-outs don't need frontmatter.
    const { parseFrontmatter } = await import("./frontmatter.js");
    const { readNote } = await import("./fs.js");

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

    void parseFrontmatter; // imported but used via readNote above

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
// applyOrganizePlan — Phase 2 stub
// ---------------------------------------------------------------------------

/**
 * Apply a previously computed organize plan.
 * @throws Error — not implemented in Phase 1.
 */
export async function applyOrganizePlan(
  _plan: OrganizePlan,
  _opts: { keepEmptyDirs?: boolean }
): Promise<ApplyResult> {
  throw new OrganizeError(
    "applyOrganizePlan is not implemented in Phase 1",
    "NOT_IMPLEMENTED"
  );
}

// ---------------------------------------------------------------------------
// undoLastOrganize — Phase 2 stub
// ---------------------------------------------------------------------------

/**
 * Undo the most recent applied organize.
 * @throws Error — not implemented in Phase 1.
 */
export async function undoLastOrganize(): Promise<UndoResult> {
  throw new OrganizeError(
    "undoLastOrganize is not implemented in Phase 1",
    "NOT_IMPLEMENTED"
  );
}
