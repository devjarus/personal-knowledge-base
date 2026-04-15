/**
 * KB stats helper — pure data computation on top of listNotes() + resolveKbRoot().
 * No filesystem access beyond what listNotes() already performs.
 */
import { listNotes } from "./fs";
import { resolveKbRoot } from "./paths";
import type { KbRootSource } from "./paths";

export interface KbStats {
  kbRoot: string;
  source: KbRootSource;
  noteCount: number;
  totalSize: number;
  /** ISO mtime of the most-recently-modified note, or null if the KB is empty. */
  lastUpdated: string | null;
  /** First-segment folder breakdown, sorted by count desc. "(root)" = notes at root level. */
  topFolders: { folder: string; count: number }[];
  /** All tags sorted by count desc. */
  topTags: { tag: string; count: number }[];
  /** Most-recently-modified notes (mtime desc). */
  recent: { path: string; mtime: string }[];
}

export async function kbStats(opts?: {
  topN?: number;
  recentN?: number;
}): Promise<KbStats> {
  const topN = opts?.topN ?? 10;
  const recentN = opts?.recentN ?? 5;

  const resolved = resolveKbRoot();
  const notes = await listNotes(); // already sorted mtime desc

  // --- Totals ---
  let totalSize = 0;
  for (const n of notes) totalSize += n.size;

  const lastUpdated = notes.length > 0 ? notes[0].mtime : null;

  // --- Top folders: first path segment only, "(root)" for top-level notes ---
  const folderCounts = new Map<string, number>();
  for (const n of notes) {
    const slash = n.path.indexOf("/");
    const folder = slash === -1 ? "(root)" : n.path.slice(0, slash);
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
  }
  const topFolders = [...folderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([folder, count]) => ({ folder, count }));

  // --- Top tags: frequency desc ---
  const tagCounts = new Map<string, number>();
  for (const n of notes) {
    for (const tag of n.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([tag, count]) => ({ tag, count }));

  // --- Recent: top N by mtime desc (notes already sorted) ---
  const recent = notes
    .slice(0, recentN)
    .map((n) => ({ path: n.path, mtime: n.mtime }));

  return {
    kbRoot: resolved.path,
    source: resolved.source,
    noteCount: notes.length,
    totalSize,
    lastUpdated,
    topFolders,
    topTags,
    recent,
  };
}
