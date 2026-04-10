import { listNotes } from "./fs";
import { readNote } from "./fs";
import type { SearchHit } from "./types";

/**
 * Naive full-text search over all notes.
 *
 * Scores by: title matches (weight 3), tag matches (weight 2), body matches (weight 1).
 * Returns a snippet around the first body match.
 *
 * Good enough for a few thousand notes; swap for minisearch/fuse later if needed.
 */
export async function searchNotes(query: string, limit = 30): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const summaries = await listNotes();
  const terms = q.split(/\s+/).filter(Boolean);

  const scored: SearchHit[] = [];
  for (const s of summaries) {
    const titleLower = s.title.toLowerCase();
    const tagsLower = s.tags.map((t) => t.toLowerCase());

    let score = 0;
    for (const term of terms) {
      if (titleLower.includes(term)) score += 3;
      if (tagsLower.some((t) => t.includes(term))) score += 2;
    }

    // Only read the body if we need a full scan.
    let snippet = s.preview;
    if (score < terms.length * 3) {
      const note = await readNote(s.path);
      const bodyLower = note.body.toLowerCase();
      let bodyMatches = 0;
      for (const term of terms) {
        if (bodyLower.includes(term)) bodyMatches += 1;
      }
      if (bodyMatches > 0) {
        score += bodyMatches;
        const idx = bodyLower.indexOf(terms[0]);
        if (idx >= 0) {
          const start = Math.max(0, idx - 60);
          const end = Math.min(note.body.length, idx + 160);
          snippet = (start > 0 ? "…" : "") + note.body.slice(start, end) + (end < note.body.length ? "…" : "");
        }
      }
    }

    if (score > 0) {
      scored.push({ path: s.path, title: s.title, score, snippet });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
