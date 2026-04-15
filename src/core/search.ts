import fs from "node:fs/promises";
import { listNotes, readNote } from "./fs";
import { refreshIndex, queryTopK, sidecarPath } from "./semanticIndex";
import { embedText } from "./embeddings";
import type { SearchHit } from "./types";

/**
 * Naive full-text search over all notes, blended with semantic cosine similarity.
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
 * Hybrid ranking (v3 — semantic layer):
 * - After keyword scoring, if the semantic index is available and the query
 *   is not a pure tag filter, blend keyword score with cosine similarity.
 * - Final score = HYBRID_ALPHA * fts_norm + (1 - HYBRID_ALPHA) * cosine
 * - α = 0.4 (locked per spec FR-5). Not a runtime flag.
 * - Tag-filter hard-narrowing happens BEFORE semantic scoring (FR-5, AC-4).
 * - Falls back to keyword-only on any semantic error (FR-6, AC-7).
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

/** Blending coefficient: 0.4 keyword + 0.6 cosine (FR-5). */
const HYBRID_ALPHA = 0.4;

/**
 * Minimum cosine similarity for a pure-semantic hit (no keyword score) to
 * enter results. Without this, nonsense queries like "xyzzy quantum foobar"
 * still pull in notes at the score floor (~0.4 * 0 + 0.6 * low-cosine) just
 * because SOMETHING has to come back top-K. Below this threshold the note
 * is assumed irrelevant.
 *
 * 0.3 was picked empirically against the live KB: thematic matches for
 * "caching strategies", "pipeline architecture", etc. land 0.3+, while
 * random-word queries sit in the 0.15–0.28 range. Tuneable if it shuts
 * out legitimate hits; the escape hatch is `KB_SEMANTIC=off` to get raw
 * keyword-only behaviour.
 */
const MIN_SEMANTIC_COSINE = 0.3;

/**
 * Whether to emit the semantic-fallback warning at most once per process.
 * Using a Set keyed on process pid + root to avoid spamming on repeated calls.
 */
let _semanticWarnedThisProcess = false;

export async function searchNotes(query: string, limit = 30): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  // KB_SEMANTIC=off escape hatch for tests / debugging (not advertised in help).
  const semanticEnabled = process.env.KB_SEMANTIC !== "off";

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

  // ---------------------------------------------------------------------------
  // Semantic layer (hybrid ranking)
  //
  // Skip if:
  //   - Pure tag filter (user is explicitly filtering, not semantically searching)
  //   - KB_SEMANTIC=off escape hatch is set
  // On any semantic error, fall back to keyword-only ranking and log once per process.
  // ---------------------------------------------------------------------------

  if (!onlyTagFilter && semanticEnabled) {
    try {
      // Check if the sidecar file exists before attempting semantic scoring.
      // FR-6: if the sidecar is absent, fall back transparently with one warning.
      const sp = sidecarPath();
      let sidecarExists = true;
      try {
        await fs.access(sp);
      } catch {
        sidecarExists = false;
      }

      if (!sidecarExists) {
        throw new Error("ENOENT: semantic index missing");
      }

      // Bring the sidecar in sync with the current listNotes (incremental only).
      await refreshIndex();

      // Embed the query.
      const qVec = await embedText(q);

      // Build a lookup set of paths already in keyword results.
      const keywordPaths = new Set(scored.map((h) => h.path));

      // Fetch top-K semantic candidates — include extras beyond keyword hits.
      const semanticK = limit * 3;
      const topKResults = queryTopK(qVec, semanticK);

      // Build a Map<path, cosine> for fast lookup in keyword scored[].
      const cosineMap = new Map<string, number>();
      for (const { path: p, cosine } of topKResults) {
        cosineMap.set(p, cosine);
      }

      // For keyword-scored notes, get their cosine (0 if not in semantic index).
      // Compute max keyword score for normalization.
      const maxKwScore = scored.reduce((mx, h) => Math.max(mx, h.score), 0);

      const merged: SearchHit[] = scored.map((h) => {
        const ftsNorm = maxKwScore > 0 ? h.score / maxKwScore : 0;
        const cosine = cosineMap.get(h.path) ?? 0;
        const hybridScore = HYBRID_ALPHA * ftsNorm + (1 - HYBRID_ALPHA) * cosine;
        return { ...h, score: hybridScore };
      });

      // Also add pure-semantic notes not in keyword results, with keyword score = 0.
      // Apply the same tag filter hard-narrowing.
      const summaryByPath = new Map(summaries.map((s) => [s.path, s]));
      for (const { path: p, cosine } of topKResults) {
        if (keywordPaths.has(p)) continue;
        // Drop low-similarity pure-semantic hits so nonsense queries return
        // empty rather than "(no hits)"-worthy noise (dogfooding issue #5).
        if (cosine < MIN_SEMANTIC_COSINE) continue;
        const s = summaryByPath.get(p);
        if (!s) continue;

        // Apply hard tag filter to semantic-only candidates.
        if (tagFilters.length > 0) {
          const tagsLower = s.tags.map((t) => t.toLowerCase());
          const ok = tagFilters.every((tf) => tagsLower.includes(tf));
          if (!ok) continue;
        }

        const hybridScore = (1 - HYBRID_ALPHA) * cosine;
        merged.push({
          path: s.path,
          title: s.title,
          score: hybridScore,
          snippet: s.preview,
        });
      }

      merged.sort((a, b) => b.score - a.score);
      return merged.slice(0, limit);
    } catch (err) {
      // Semantic path failed — fall back to keyword-only. Log once per process (AC-7).
      if (!_semanticWarnedThisProcess) {
        _semanticWarnedThisProcess = true;
        const reason = err instanceof Error ? err.message : String(err);
        if (reason.includes("ENOENT") || reason.includes("missing")) {
          process.stderr.write(
            "semantic index missing, falling back to keyword search\n"
          );
        } else {
          process.stderr.write(
            `semantic index missing, falling back to keyword search (${reason})\n`
          );
        }
      }
      // Fall through to keyword-only sort below.
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
