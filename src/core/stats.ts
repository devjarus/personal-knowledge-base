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

  // --- Top folders: two-level drill-down ---
  // First pass: first-segment buckets. If any single bucket dominates (>50% of
  // notes) we swap it out for its second-segment children so the user sees
  // meaningful structure instead of one monolithic "imports" row. Root-level
  // notes stay under "(root)". Notes one level deep keep their first-segment
  // name (no second level exists).
  const firstLevel = new Map<string, string[]>();
  for (const n of notes) {
    const parts = n.path.split("/");
    const key = parts.length === 1 ? "(root)" : parts[0];
    const bucket = firstLevel.get(key) ?? [];
    bucket.push(n.path);
    firstLevel.set(key, bucket);
  }

  const DOMINANT_RATIO = 0.5;
  const expanded: { folder: string; count: number }[] = [];
  for (const [folder, paths] of firstLevel) {
    const shouldExpand =
      folder !== "(root)" &&
      notes.length > 0 &&
      paths.length / notes.length > DOMINANT_RATIO;
    if (!shouldExpand) {
      expanded.push({ folder, count: paths.length });
      continue;
    }
    // Break this bucket into second-level groups under "folder/sub".
    const subCounts = new Map<string, number>();
    for (const p of paths) {
      const parts = p.split("/");
      const subKey = parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0];
      subCounts.set(subKey, (subCounts.get(subKey) ?? 0) + 1);
    }
    for (const [sub, count] of subCounts) {
      expanded.push({ folder: sub, count });
    }
  }

  const topFolders = expanded
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

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
