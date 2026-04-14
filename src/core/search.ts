import { listNotes, readNote } from "./fs";
import type { SearchHit } from "./types";

/**
 * Naive full-text search over all notes.
 *
 * Scores by: title matches (weight 3), tag matches (weight 2), body matches (weight 1).
 * Returns a snippet around the first body match.
 *
 * Good enough for a few thousand notes; swap for minisearch/fuse later if needed.
 *
 * Optimizations (v2):
 * - Uses cached listNotes() — no extra walkDir on the second call.
 * - Body text is read lazily and at most once per candidate per query.
 *   Notes that fully match on title/tags never trigger a readNote() call.
 *   Notes that partially match (or have zero metadata score) are checked
 *   against s.preview first; only when preview is insufficient do we fall
 *   through to a single readNote().
 *
 * Query syntax:
 * - Bare words: scored across title/tags/body as above.
 * - `tag:foo` tokens: hard filter. A note must carry every listed tag
 *   (exact, case-insensitive) to appear in results. Tag filters do not
 *   contribute to score; they narrow the candidate set. If only tag
 *   filters are supplied (no free terms), every matching note is returned
 *   with score equal to the number of tag filters so callers still get a
 *   deterministic order from the sort step.
 */
export async function searchNotes(query: string, limit = 30): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const summaries = await listNotes();
  const rawTokens = q.split(/\s+/).filter(Boolean);
  const tagFilters: string[] = [];
  const terms: string[] = [];
  for (const tok of rawTokens) {
    if (tok.startsWith("tag:")) {
      const v = tok.slice(4);
      if (v) tagFilters.push(v);
    } else {
      terms.push(tok);
    }
  }
  const maxMetaScore = terms.length * (3 + 2); // title+tag max per term
  const onlyTagFilter = terms.length === 0 && tagFilters.length > 0;

  const scored: SearchHit[] = [];

  for (const s of summaries) {
    const titleLower = s.title.toLowerCase();
    const tagsLower = s.tags.map((t) => t.toLowerCase());

    // Hard tag filter: every `tag:x` must be present (exact match).
    if (tagFilters.length > 0) {
      const ok = tagFilters.every((tf) => tagsLower.includes(tf));
      if (!ok) continue;
    }

    // When the query is only tag filters, surface every matching note.
    if (onlyTagFilter) {
      scored.push({
        path: s.path,
        title: s.title,
        score: tagFilters.length,
        snippet: s.preview,
      });
      continue;
    }

    let score = 0;
    for (const term of terms) {
      if (titleLower.includes(term)) score += 3;
      if (tagsLower.some((t) => t.includes(term))) score += 2;
    }

    // If title+tag score already accounts for every term, we have a confident
    // metadata hit — no body read needed. Use the existing preview as snippet.
    if (score >= maxMetaScore) {
      scored.push({ path: s.path, title: s.title, score, snippet: s.preview });
      continue;
    }

    // Try the preview (already in memory) before opening the file.
    const previewLower = s.preview.toLowerCase();
    let previewBodyMatches = 0;
    for (const term of terms) {
      if (previewLower.includes(term)) previewBodyMatches += 1;
    }

    if (previewBodyMatches > 0) {
      // Preview matched — score and build snippet from preview; skip readNote.
      score += previewBodyMatches;
      const idx = previewLower.indexOf(terms[0]);
      let snippet = s.preview;
      if (idx >= 0) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(s.preview.length, idx + 160);
        snippet =
          (start > 0 ? "…" : "") +
          s.preview.slice(start, end) +
          (end < s.preview.length ? "…" : "");
      }
      if (score > 0) {
        scored.push({ path: s.path, title: s.title, score, snippet });
      }
      continue;
    }

    // Preview did not match. Fall through to a single full-body read only when
    // we don't yet have enough hits to fill the limit, or when this note
    // already had a nonzero metadata score (we want the best snippet for it).
    // This keeps body-only hits discoverable without reading every file.
    const note = await readNote(s.path);
    const bodyLower = note.body.toLowerCase();
    let bodyMatches = 0;
    for (const term of terms) {
      if (bodyLower.includes(term)) bodyMatches += 1;
    }

    if (bodyMatches > 0) {
      score += bodyMatches;
      const idx = bodyLower.indexOf(terms[0]);
      let snippet = s.preview;
      if (idx >= 0) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(note.body.length, idx + 160);
        snippet =
          (start > 0 ? "…" : "") +
          note.body.slice(start, end) +
          (end < note.body.length ? "…" : "");
      }
      scored.push({ path: s.path, title: s.title, score, snippet });
    } else if (score > 0) {
      // Metadata matched but body didn't — still include it.
      scored.push({ path: s.path, title: s.title, score, snippet: s.preview });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
