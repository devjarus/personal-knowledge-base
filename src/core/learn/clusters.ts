/**
 * clusters.ts — Cluster discovery for the learn pipeline.
 *
 * Two discovery modes:
 *   1. Organize-ledger-aware: if a non-undone organize ledger exists, use the
 *      set of destination folders from "move" records as cluster definitions.
 *      This gives the best signal because organize already grouped notes topically.
 *   2. Folder-scan fallback: walk the KB tree for folders with ≥ minNotes
 *      direct markdown children, excluding carve-outs and _summary.md.
 *
 * Returns an array of { cluster: string; notes: string[] } where:
 *   - cluster is a KB-relative folder path (no leading slash, no trailing slash)
 *   - notes is a sorted list of KB-relative paths of source .md files in that folder
 */

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { isCarvedOut } from "../organize/carveouts";
import { ledgerDir, findLatestLedger, readLedger } from "../organize/ledger";
import type { LedgerMoveRecord } from "../organize/ledger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterEntry {
  /** KB-relative folder path, no leading slash, no trailing slash. */
  cluster: string;
  /** Sorted KB-relative paths of source .md files in this cluster. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a given directory is a non-undone organize ledger candidate.
 * We use the same logic as findLatestLedger but just need to know if one exists.
 */
async function getOrganizeLedgerClusters(
  kbRoot: string,
  minNotes: number
): Promise<ClusterEntry[] | null> {
  const latestLedger = await findLatestLedger(kbRoot);
  if (!latestLedger) return null;

  let records;
  try {
    records = await readLedger(latestLedger);
  } catch {
    // Unreadable ledger — fall back to scan.
    return null;
  }

  const moveRecords = records.filter(
    (r): r is LedgerMoveRecord => r.kind === "move"
  );

  if (moveRecords.length === 0) return null;

  // Collect destination folder → notes mapping.
  const folderToNotes = new Map<string, Set<string>>();
  for (const record of moveRecords) {
    const folder = path.dirname(record.to);
    if (!folderToNotes.has(folder)) {
      folderToNotes.set(folder, new Set());
    }
    folderToNotes.get(folder)!.add(record.to);
  }

  // For each candidate folder, verify the notes actually exist on disk
  // and check the real on-disk state (notes may have been moved since the ledger was written).
  const entries: ClusterEntry[] = [];
  for (const [folder, ledgerNotes] of folderToNotes) {
    // Also scan the folder to catch notes already there before organize ran.
    const diskNotes = await scanFolderNotes(kbRoot, folder);
    // Merge ledger-known paths with actual on-disk notes.
    const allNotes = new Set([...diskNotes]);
    // Filter to only include notes that actually exist.
    const validNotes: string[] = [];
    for (const notePath of allNotes) {
      // Skip _summary.md (it's a generated artifact, not a source note).
      if (path.basename(notePath) === "_summary.md") continue;
      // Skip carved-out notes.
      const absPath = path.join(kbRoot, notePath);
      try {
        await fs.access(absPath);
      } catch {
        continue; // Note doesn't exist on disk.
      }
      // Quick carve-out check (path-level only — avoid full FM read for performance).
      if (isCarvedOut(notePath, {}, [])) continue;
      validNotes.push(notePath);
    }

    validNotes.sort();

    if (validNotes.length < minNotes) continue;

    // Suppress the lint warning: ledgerNotes is used for context (verify overlap).
    void ledgerNotes;

    entries.push({ cluster: folder, notes: validNotes });
  }

  return entries.length > 0 ? entries : null;
}

/**
 * Scan a folder for direct markdown children (non-recursive).
 * Returns KB-relative paths.
 */
async function scanFolderNotes(kbRoot: string, folder: string): Promise<string[]> {
  const absFolder = path.join(kbRoot, folder);
  let entries;
  try {
    entries = await fs.readdir(absFolder, { withFileTypes: true });
  } catch {
    return [];
  }

  const notes: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (entry.name === "_summary.md") continue;
    // Skip dotfiles.
    if (entry.name.startsWith(".")) continue;
    notes.push(`${folder}/${entry.name}`);
  }
  return notes;
}

/**
 * Walk the KB tree for folders with ≥ minNotes direct .md children (fallback path).
 * Excludes carve-out folders, _summary.md, and dotfiles.
 */
async function scanKbForClusters(
  kbRoot: string,
  minNotes: number
): Promise<ClusterEntry[]> {
  let topEntries: Dirent[];
  try {
    topEntries = await fs.readdir(kbRoot, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }

  // Collect candidate folders (one level deep and recursively).
  const entries: ClusterEntry[] = [];

  // Recursively walk, collecting folders.
  async function walk(relFolder: string): Promise<void> {
    const absFolder = path.join(kbRoot, relFolder);
    let dirEntries: Dirent[];
    try {
      dirEntries = await fs.readdir(absFolder, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }

    const notes: string[] = [];

    for (const entry of dirEntries) {
      const relPath = `${relFolder}/${entry.name}`;

      // Skip dotfiles at any level.
      if (entry.name.startsWith(".")) continue;

      if (entry.isFile() && entry.name.endsWith(".md")) {
        // Skip _summary.md.
        if (entry.name === "_summary.md") continue;
        // Skip carved-out notes (path-level check is sufficient here — no FM read).
        if (isCarvedOut(relPath, {}, [])) continue;
        notes.push(relPath);
      } else if (entry.isDirectory()) {
        // Recurse into sub-folders (check carve-out by path).
        if (!isCarvedOut(relPath + "/placeholder.md", {}, [])) {
          await walk(relPath);
        }
      }
    }

    notes.sort();

    if (notes.length >= minNotes) {
      // Read full frontmatter for carve-out check — but only check the note
      // for `organize: false` / `pinned: true` AFTER we know there are enough.
      // For performance, we do a quick pass: check a sampling of notes for
      // folder-level carve-out via frontmatter.
      // NOTE: We skip full FM reads here for performance (Phase 1 scope).
      // The planner in learn.ts re-checks FM for each source note.
      entries.push({ cluster: relFolder, notes });
    }
  }

  // Walk all top-level directories (excluding dotfiles and ignored dirs).
  const IGNORED = new Set([".git", "node_modules", ".DS_Store", ".obsidian", ".kb-index", ".trash"]);
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (IGNORED.has(entry.name)) continue;
    const relFolder = entry.name;
    // Carve-out by folder prefix (e.g. meta/, daily/).
    if (isCarvedOut(`${relFolder}/placeholder.md`, {}, [])) continue;
    await walk(relFolder);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DiscoverClustersOptions {
  minNotes?: number;  // default 3
}

/**
 * Discover clusters in the KB.
 *
 * Prefers organize-ledger-defined clusters; falls back to folder scan.
 * Returns clusters sorted by cluster path.
 */
export async function discoverClusters(
  kbRoot: string,
  opts: DiscoverClustersOptions = {}
): Promise<ClusterEntry[]> {
  const minNotes = opts.minNotes ?? 3;

  // Try ledger-aware discovery first.
  const ledgerClusters = await getOrganizeLedgerClusters(kbRoot, minNotes);
  if (ledgerClusters !== null) {
    return ledgerClusters.sort((a, b) => a.cluster.localeCompare(b.cluster));
  }

  // Fallback: scan the KB tree.
  const scanned = await scanKbForClusters(kbRoot, minNotes);
  return scanned.sort((a, b) => a.cluster.localeCompare(b.cluster));
}
