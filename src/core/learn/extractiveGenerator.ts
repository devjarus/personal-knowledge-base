/**
 * extractiveGenerator.ts — Deterministic extractive summary generator.
 *
 * Algorithm (locked from plan.md):
 *
 *   1. Centroid: sum each source note's embedding vector; divide by N; L2-normalize.
 *   2. Rank by cosine: sort notes descending by cosine(note.embedding, centroid);
 *      stable tie-break on path.
 *   3. Key points: top K = min(5, clusterSize) ranked notes; extract first sentence
 *      of each excerpt (split on /(?<=[.!?])\s+/, take index 0, trim, cap 250 chars).
 *      If sentence is empty, skip. If < 3 collected, backfill from next ranked note's
 *      second sentence.
 *   4. Themes: aggregate tag frequencies across ALL source notes; top 5 by frequency
 *      (tie-break alphabetical). If < 3 tags total, fall back to title-word frequency
 *      (split on non-alphanumeric, drop stopwords).
 *   5. Open questions: scan excerpts of top-K notes for sentences ending in '?';
 *      dedupe case-insensitively; cap at 3. If none, return [].
 *
 * Fully deterministic — same inputs → same output. Never throws.
 */

import type { PromptInput, GeneratedSummary } from "./prompts";

// ---------------------------------------------------------------------------
// Stopwords for title-word fallback (small hardcoded set)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "was", "are", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "must", "can", "not", "no", "nor",
  "so", "yet", "both", "either", "neither", "this", "that", "these",
  "those", "my", "your", "his", "her", "its", "our", "their", "what",
  "which", "who", "whom", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such",
  "than", "then", "there", "about", "above", "after", "before", "between",
  "into", "through", "during", "without", "within", "along", "following",
  "across", "behind", "beyond", "plus", "except", "up", "out", "around",
  "down", "off", "over", "under", "again", "further", "once",
]);

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

/** L2-normalize a Float32Array in-place. Returns the same array. */
function l2normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-10) return vec; // zero vector — leave as-is
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Dot product of two Float32Arrays. */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

/**
 * Split text into sentences using lookbehind on [.!?] followed by whitespace.
 * Returns non-empty trimmed sentences only.
 */
function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace.
  // The lookbehind /(?<=[.!?])\s+/ is supported in Node 24.
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Step 1 + 2: Centroid and cosine ranking
// ---------------------------------------------------------------------------

/**
 * Compute the centroid of the given embeddings and return notes sorted
 * descending by cosine similarity to the centroid.
 * Stable tie-break: ascending path alphabetical.
 *
 * Notes without an embedding entry in the map are ranked last (cosine = -Infinity),
 * after notes with real embeddings, preserving path-alphabetical tie-break among themselves.
 */
function rankByCentroid(
  notes: Array<{ path: string; excerpt: string; tags: string[]; title: string }>,
  embeddings: Map<string, Float32Array>
): Array<{ path: string; excerpt: string; tags: string[]; title: string; cosine: number }> {
  if (notes.length === 0) return [];

  // Collect embeddings for notes that have them.
  const noteVecs: Array<{ path: string; vec: Float32Array }> = [];
  for (const note of notes) {
    const vec = embeddings.get(note.path);
    if (vec) noteVecs.push({ path: note.path, vec });
  }

  // Compute centroid.
  let centroid: Float32Array | null = null;
  if (noteVecs.length > 0) {
    const dim = noteVecs[0].vec.length;
    centroid = new Float32Array(dim);
    for (const { vec } of noteVecs) {
      for (let i = 0; i < dim; i++) centroid[i] += vec[i];
    }
    // Divide by N then L2-normalize.
    for (let i = 0; i < dim; i++) centroid[i] /= noteVecs.length;
    l2normalize(centroid);
  }

  // Score each note.
  return notes
    .map((note) => {
      const vec = centroid ? embeddings.get(note.path) : undefined;
      const cosine = vec && centroid ? dot(vec, centroid) : -Infinity;
      return { ...note, cosine };
    })
    .sort((a, b) => {
      if (b.cosine !== a.cosine) return b.cosine - a.cosine;
      // Stable tie-break: ascending path.
      return a.path.localeCompare(b.path);
    });
}

// ---------------------------------------------------------------------------
// Step 3: Key points
// ---------------------------------------------------------------------------

/**
 * Extract key points from ranked notes.
 * Takes the top K = min(5, clusterSize) ranked notes.
 * Returns a list of first sentences, capped at 250 chars.
 * Backfills from second sentences if < 3 collected.
 */
function extractKeyPoints(
  ranked: Array<{ path: string; excerpt: string; cosine: number }>,
  clusterSize: number
): string[] {
  const K = Math.min(5, clusterSize);
  const topK = ranked.slice(0, K);

  const points: string[] = [];

  // First pass: first sentence from each top-K note.
  const remainingByNote: string[][] = [];
  for (const note of topK) {
    const sentences = splitSentences(note.excerpt);
    if (sentences.length === 0) {
      remainingByNote.push([]);
      continue;
    }
    const first = sentences[0].slice(0, 250);
    if (first.length > 0) {
      points.push(first);
    }
    remainingByNote.push(sentences.slice(1));
  }

  // Backfill: if fewer than 3 key points, take second sentences from top-K notes.
  if (points.length < 3) {
    for (let i = 0; i < topK.length && points.length < 3; i++) {
      const remaining = remainingByNote[i];
      if (remaining.length > 0) {
        const second = remaining[0].slice(0, 250);
        if (second.length > 0 && !points.includes(second)) {
          points.push(second);
        }
      }
    }
  }

  return points;
}

// ---------------------------------------------------------------------------
// Step 4: Themes from tag frequencies
// ---------------------------------------------------------------------------

/**
 * Compute themes from tag frequencies across all source notes.
 * Falls back to title-word frequency if < 3 distinct tags exist.
 */
function extractThemes(
  notes: Array<{ path: string; tags: string[]; title: string }>
): string[] {
  // Aggregate tag frequencies.
  const tagFreq = new Map<string, number>();
  for (const note of notes) {
    for (const tag of note.tags) {
      const lower = tag.toLowerCase().trim();
      if (lower.length === 0) continue;
      tagFreq.set(lower, (tagFreq.get(lower) ?? 0) + 1);
    }
  }

  if (tagFreq.size >= 3) {
    // Sort by frequency desc, tie-break alphabetical asc.
    const sorted = [...tagFreq.entries()].sort(([aTag, aFreq], [bTag, bFreq]) => {
      if (bFreq !== aFreq) return bFreq - aFreq;
      return aTag.localeCompare(bTag);
    });
    return sorted.slice(0, 5).map(([tag]) => tag);
  }

  // Fallback: title-word frequency.
  const wordFreq = new Map<string, number>();
  for (const note of notes) {
    const words = note.title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
    }
  }

  const sorted = [...wordFreq.entries()].sort(([aW, aF], [bW, bF]) => {
    if (bF !== aF) return bF - aF;
    return aW.localeCompare(bW);
  });

  const themes = sorted.slice(0, 5).map(([word]) => word);

  // If we have existing tags (< 3), include them first.
  const existingTags = [...tagFreq.keys()].sort();
  const combined = [...existingTags, ...themes.filter((t) => !existingTags.includes(t))];
  return combined.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Step 5: Open questions
// ---------------------------------------------------------------------------

/**
 * Scan excerpts of top-K notes for sentences ending in '?'.
 * Dedupe case-insensitively. Cap at 3.
 */
function extractOpenQuestions(
  ranked: Array<{ excerpt: string }>,
  clusterSize: number
): string[] {
  const K = Math.min(5, clusterSize);
  const topK = ranked.slice(0, K);

  const questions: string[] = [];
  const seen = new Set<string>();

  for (const note of topK) {
    const sentences = splitSentences(note.excerpt);
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed.endsWith("?")) continue;
      const lower = trimmed.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      questions.push(trimmed);
      if (questions.length >= 3) return questions;
    }
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deterministic extractive summary generator.
 *
 * @param input      PromptInput with cluster name and notes (title, tags, excerpt, path).
 * @param embeddings Map from KB-relative path → Float32Array embedding vector.
 *                   Notes missing from the map are ranked last for key-point extraction.
 * @returns          GeneratedSummary — never throws, always returns a valid structure.
 */
export function generateExtractive(
  input: PromptInput,
  embeddings: Map<string, Float32Array>
): GeneratedSummary {
  const { notes } = input;

  if (notes.length === 0) {
    return { themes: [], keyPoints: [], openQuestions: [] };
  }

  // Steps 1 + 2: Rank by centroid similarity.
  const ranked = rankByCentroid(notes, embeddings);

  // Step 3: Key points from top-K first sentences.
  const keyPoints = extractKeyPoints(ranked, notes.length);

  // Step 4: Themes from tag frequencies.
  const themes = extractThemes(notes);

  // Step 5: Open questions from top-K excerpts.
  const openQuestions = extractOpenQuestions(ranked, notes.length);

  return { themes, keyPoints, openQuestions };
}
