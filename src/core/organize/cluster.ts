/**
 * cluster.ts — hand-rolled agglomerative clustering over cosine distance.
 *
 * Algorithm choice: **complete-linkage** (maximum distance between any two
 * points in two clusters). Selected over single-linkage (prone to chaining)
 * and Ward's (requires Euclidean space; cosine distance is not Euclidean).
 * Complete-linkage produces compact, cohesive clusters — desirable for
 * topic folder generation where we want tight semantic groups.
 *
 * Auto-k via elbow method on the merge-distance curve:
 *   We record the complete-linkage distance of each merge. The elbow is the
 *   step where the next merge would require a big jump in distance (i.e. we'd
 *   be merging increasingly dissimilar clusters). We stop just before that jump.
 *   Result is capped at `maxClusters`.
 *
 *   For large corpora (N > 50), a minimum cluster floor is enforced:
 *   at least Math.max(8, Math.ceil(N / 25)) clusters. The elbow method only
 *   decides whether to split BEYOND the minimum — it runs within the range
 *   [minClusters, maxClusters].
 *
 * Corpus-wide stop word filtering:
 *   Before TF-IDF scoring, terms that appear in >60% of all notes (across
 *   ALL cluster inputs) are added to the stop-word set. This prevents
 *   domain-saturated terms (e.g. "agent", "skill") from dominating every
 *   cluster's label.
 *
 * Tokenization for top-term extraction:
 *   Input: title tokens + tag tokens per note.
 *   Steps: lowercase → remove non-alphanumeric → filter stop-words + short
 *          tokens (length < 3) → compute TF-IDF-like score: (term freq in
 *          cluster) / (doc freq across all clusters). Top-3 by score become
 *          the cluster label input for `deriveFolderName`.
 *
 * Determinism guarantee:
 *   - Inputs are sorted by path before processing (caller should also sort,
 *     but we sort here defensively).
 *   - No Math.random() anywhere in this module.
 *   - Tie-breaking in merge selection uses lexicographic cluster index order.
 *
 * No filesystem I/O. Pure function over Float32Array vectors.
 */

import { deriveFolderName } from "./folderName.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClusterInput {
  path: string;
  embedding: Float32Array;
  /** Tokenized terms from the note's title (pre-tokenized by caller). */
  titleTerms: string[];
  /** Tags from frontmatter (pre-tokenized/cleaned by caller). */
  tagTerms: string[];
}

export interface ClusterResult {
  folder: string;
  centroid: Float32Array;
  topTerms: string[];
  memberPaths: string[];
}

export interface ClusterOutput {
  clusters: ClusterResult[];
  /** path → { folder, confidence } — confidence = cosine to centroid */
  assignments: Map<string, { folder: string; confidence: number }>;
  /** paths that fell below minConfidence */
  unassigned: string[];
}

// ---------------------------------------------------------------------------
// Corpus-wide stop-word threshold: terms appearing in more than this fraction
// of ALL input notes are treated as corpus-specific noise and excluded from
// TF-IDF scoring. This prevents domain-saturating terms (e.g. "agent") from
// appearing as top terms in every cluster.
// ---------------------------------------------------------------------------

const CORPUS_STOP_WORD_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Stop-word list for TF-IDF term extraction.
// Keep it small and local — no new deps.
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "was", "are", "be", "been", "has",
  "have", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "can", "this", "that", "these", "those", "it", "its",
  "my", "your", "our", "their", "we", "you", "they", "he", "she", "not",
  "no", "note", "notes", "file", "files", "page", "doc", "document",
]);

// ---------------------------------------------------------------------------
// Cosine similarity between two Float32Array unit vectors.
// (dot product = cosine for unit-normalized vectors)
// ---------------------------------------------------------------------------

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ---------------------------------------------------------------------------
// Centroid: mean of a set of unit vectors, re-normalized.
// ---------------------------------------------------------------------------

function computeCentroid(vecs: Float32Array[]): Float32Array {
  const dim = vecs[0].length;
  const sum = new Float32Array(dim);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += sum[i] * sum[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) sum[i] /= norm;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Tokenize a string into cleaned lowercase tokens.
// Accepts an optional extra stop-word set (e.g. corpus-wide dynamic stops).
// ---------------------------------------------------------------------------

function tokenize(text: string, extraStops?: Set<string>): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t) && !(extraStops?.has(t)));
}

// ---------------------------------------------------------------------------
// Compute corpus-wide stop words: terms that appear in >CORPUS_STOP_WORD_THRESHOLD
// fraction of all notes (across all cluster inputs, pre-clustering). These terms
// are domain-saturated and provide no discriminating signal for cluster naming.
// ---------------------------------------------------------------------------

function computeCorpusStopWords(allInputs: ClusterInput[]): Set<string> {
  if (allInputs.length === 0) return new Set();

  const docFreq = new Map<string, number>(); // term → # notes containing it
  for (const inp of allInputs) {
    // Use base STOP_WORDS only here (we're building the extended set, not using it yet).
    const allTerms = new Set<string>([
      ...inp.titleTerms.flatMap((t) => tokenize(t)),
      ...inp.tagTerms.flatMap((t) => tokenize(t)),
    ]);
    for (const t of allTerms) {
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
  }

  const threshold = CORPUS_STOP_WORD_THRESHOLD * allInputs.length;
  const corpusStops = new Set<string>();
  for (const [term, freq] of docFreq.entries()) {
    if (freq > threshold) {
      corpusStops.add(term);
    }
  }
  return corpusStops;
}

// ---------------------------------------------------------------------------
// Extract top-N distinctive terms across a cluster using TF-IDF-like scoring.
// ---------------------------------------------------------------------------

function extractTopTerms(
  clusterInputs: ClusterInput[],
  allClusterInputs: ClusterInput[][],
  topN: number,
  corpusStopWords?: Set<string>
): string[] {
  const totalClusters = Math.max(allClusterInputs.length, 1);

  // Build term-frequency map for this cluster.
  const tf = new Map<string, number>();
  for (const inp of clusterInputs) {
    const allTerms = [
      ...inp.titleTerms.flatMap((t) => tokenize(t, corpusStopWords)),
      ...inp.tagTerms.flatMap((t) => tokenize(t, corpusStopWords)),
    ];
    for (const t of allTerms) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
  }

  if (tf.size === 0) return [];

  // Build document-frequency map: how many clusters contain each term.
  const df = new Map<string, number>();
  for (const cInputs of allClusterInputs) {
    const clusterTerms = new Set<string>();
    for (const inp of cInputs) {
      const allTerms = [
        ...inp.titleTerms.flatMap((t) => tokenize(t, corpusStopWords)),
        ...inp.tagTerms.flatMap((t) => tokenize(t, corpusStopWords)),
      ];
      for (const t of allTerms) clusterTerms.add(t);
    }
    for (const t of clusterTerms) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  // Score = TF * IDF (log-smoothed).
  const scores: Array<[string, number]> = [];
  for (const [term, freq] of tf.entries()) {
    const docFreq = df.get(term) ?? 1;
    const idf = Math.log(totalClusters / (1 + docFreq) + 1);
    scores.push([term, freq * idf]);
  }

  // Sort descending by score, then lexicographically for determinism.
  scores.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  return scores.slice(0, topN).map(([t]) => t);
}

// ---------------------------------------------------------------------------
// Complete-linkage distance between two clusters.
// = max cosine distance (1 - similarity) between any pair of members.
// ---------------------------------------------------------------------------

function completeLinkageDistance(
  aMembers: Float32Array[],
  bMembers: Float32Array[]
): number {
  let maxDist = -Infinity;
  for (const a of aMembers) {
    for (const b of bMembers) {
      const dist = 1 - cosineSimilarity(a, b);
      if (dist > maxDist) maxDist = dist;
    }
  }
  return maxDist;
}

// ---------------------------------------------------------------------------
// Elbow detection on merge-distance curve.
//
// `mergeDistances[i]` = the complete-linkage distance at which merge #i was
// performed (ascending order since we always pick the cheapest merge).
//
// The elbow is the index where the relative jump to the next merge is largest
// (i.e. a big gap in merge distances signals "stop here"). We return the number
// of merges to perform = elbow index + 1 (merges 0..elbow inclusive).
//
// If no clear elbow (distances are all equal), return mergeDistances.length
// to keep all merges.
// ---------------------------------------------------------------------------

function elbowMergeCount(
  mergeDistances: number[],
  maxClusters: number,
  minClusters: number,
  n: number
): number {
  if (mergeDistances.length === 0) return 0;

  // After k merges we have n - k clusters.
  // To have AT MOST maxClusters: need at least n - maxClusters merges.
  // To have AT LEAST minClusters: need at most n - minClusters merges.
  const minMerges = Math.max(0, n - maxClusters);
  const maxMergesForMinClusters = Math.max(0, n - minClusters);
  const maxMerges = Math.min(mergeDistances.length, maxMergesForMinClusters);

  if (minMerges >= maxMerges) {
    // The minClusters floor forces us to stop at exactly maxMergesForMinClusters merges.
    return maxMerges;
  }

  // Find the biggest gap in merge distances within [minMerges, maxMerges - 1].
  // The elbow is the point where the NEXT merge would be significantly more expensive.
  // We run within [minClusters, maxClusters] range only — not below minClusters.
  let bestGapIdx = minMerges; // default: do exactly minMerges merges
  let bestGap = -1;

  for (let i = minMerges; i < maxMerges - 1; i++) {
    const gap = mergeDistances[i + 1] - mergeDistances[i];
    if (gap > bestGap) {
      bestGap = gap;
      bestGapIdx = i;
    }
  }

  // We stop BEFORE the big gap: perform merges 0..bestGapIdx (inclusive).
  // If bestGap is effectively 0 (all distances equal), fall back to the minClusters
  // floor — enforce minimum granularity rather than collapsing to 1 cluster.
  const threshold = 0.01; // minimum meaningful gap
  if (bestGap < threshold) {
    // LOAD-BEARING: without this, a corpus of similar notes (all about "agents") would
    // collapse to 1 cluster because no gap exceeds the threshold. We honor the
    // minClusters floor to produce the requested granularity even on uniform corpora.
    return maxMerges; // stop at minClusters (maxMergesForMinClusters)
  }

  return bestGapIdx + 1;
}

// ---------------------------------------------------------------------------
// Public: cluster()
// ---------------------------------------------------------------------------

/**
 * Cluster a set of notes via agglomerative clustering (complete-linkage, cosine).
 * Inputs MUST have pre-normalized (unit-length) embeddings.
 *
 * @param inputs        Notes to cluster — sorted by path for determinism.
 * @param opts.minConfidence  Minimum cosine similarity to cluster centroid;
 *                            notes below this go to `unassigned`.
 * @param opts.maxClusters    Upper bound on cluster count (default 20).
 * @param opts.minClusters    Lower bound on cluster count. For N > 50 notes,
 *                            caller should pass Math.max(8, Math.ceil(N / 25)).
 *                            Defaults to 1 (no floor).
 * @returns ClusterOutput with clusters, assignments, and unassigned list.
 */
export function cluster(
  inputs: ClusterInput[],
  opts: { minConfidence: number; maxClusters: number; minClusters?: number }
): ClusterOutput {
  const { minConfidence, maxClusters } = opts;
  // minClusters floor: defaults to 1 (no enforcement) if not provided.
  // For large corpora, callers should pass Math.max(8, Math.ceil(n / 25)).
  const minClusters = opts.minClusters ?? 1;

  // Edge case: empty or single note can't form a meaningful cluster.
  if (inputs.length === 0) {
    return { clusters: [], assignments: new Map(), unassigned: [] };
  }
  if (inputs.length === 1) {
    return {
      clusters: [],
      assignments: new Map(),
      unassigned: [inputs[0].path],
    };
  }

  // Defensive sort for determinism (caller should sort too, but belt-and-suspenders).
  const sorted = [...inputs].sort((a, b) => a.path.localeCompare(b.path));
  const n = sorted.length;

  // Compute corpus-wide stop words before clustering (pre-clustering, across ALL inputs).
  // These are terms that appear in >60% of notes — domain noise like "agent", "skill".
  const corpusStopWords = computeCorpusStopWords(sorted);

  // ---------------------------------------------------------------------------
  // Phase 1: Run the FULL agglomerative merge (down to 1 cluster) and record
  // the merge distance at each step. This gives us the complete dendrogram.
  // ---------------------------------------------------------------------------

  // Working state: each note starts as its own cluster.
  let members: Float32Array[][] = sorted.map((inp) => [inp.embedding]);
  let indices: number[][] = sorted.map((_, i) => [i]);
  const mergeDistances: number[] = [];

  while (members.length > 1) {
    const k = members.length;
    let minDist = Infinity;
    let mergeA = -1;
    let mergeB = -1;

    // Find the cheapest merge (smallest complete-linkage distance).
    // Tie-break by (a, b) index pair for determinism.
    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        const d = completeLinkageDistance(members[a], members[b]);
        if (d < minDist) {
          minDist = d;
          mergeA = a;
          mergeB = b;
        }
        // LOAD-BEARING: strict tie-breaking ensures determinism across runs.
        // Without this, ties could be broken differently on each invocation.
        else if (d === minDist && (a < mergeA || (a === mergeA && b < mergeB))) {
          mergeA = a;
          mergeB = b;
        }
      }
    }

    mergeDistances.push(minDist);

    const merged = [...members[mergeA], ...members[mergeB]];
    const mergedIdx = [...indices[mergeA], ...indices[mergeB]];
    // Remove higher-index first to avoid shifting.
    members.splice(mergeB, 1);
    indices.splice(mergeB, 1);
    members[mergeA] = merged;
    indices[mergeA] = mergedIdx;
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Pick the cut point using elbow detection.
  // After `cutMerges` merges, we have `n - cutMerges` clusters.
  // ---------------------------------------------------------------------------

  const cutMerges = elbowMergeCount(mergeDistances, maxClusters, minClusters, n);

  // ---------------------------------------------------------------------------
  // Phase 3: Re-run merging to get the final cluster assignment at the cut point.
  // ---------------------------------------------------------------------------

  let finalMembers: Float32Array[][] = sorted.map((inp) => [inp.embedding]);
  let finalIndices: number[][] = sorted.map((_, i) => [i]);

  for (let step = 0; step < cutMerges && finalMembers.length > 1; step++) {
    const k = finalMembers.length;
    let minDist = Infinity;
    let mergeA = -1;
    let mergeB = -1;

    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        const d = completeLinkageDistance(finalMembers[a], finalMembers[b]);
        if (d < minDist) {
          minDist = d;
          mergeA = a;
          mergeB = b;
        } else if (d === minDist && (a < mergeA || (a === mergeA && b < mergeB))) {
          mergeA = a;
          mergeB = b;
        }
      }
    }

    const merged = [...finalMembers[mergeA], ...finalMembers[mergeB]];
    const mergedIdx = [...finalIndices[mergeA], ...finalIndices[mergeB]];
    finalMembers.splice(mergeB, 1);
    finalIndices.splice(mergeB, 1);
    finalMembers[mergeA] = merged;
    finalIndices[mergeA] = mergedIdx;
  }

  // ---------------------------------------------------------------------------
  // Phase 4: Build ClusterResult for each final cluster.
  // Single-member clusters → unassigned (not a meaningful topic cluster).
  // Notes below minConfidence → unassigned.
  // ---------------------------------------------------------------------------

  const usedFolders = new Set<string>();
  const assignments = new Map<string, { folder: string; confidence: number }>();
  const unassigned: string[] = [];
  const clusterResults: ClusterResult[] = [];

  // Build the map of which ClusterInputs belong to each final cluster.
  const clusterInputGroups: ClusterInput[][] = finalIndices.map((idxGroup) =>
    idxGroup.map((i) => sorted[i])
  );

  for (let ci = 0; ci < finalMembers.length; ci++) {
    const mems = finalMembers[ci];
    const memberPaths = finalIndices[ci].map((i) => sorted[i].path);
    const centroid = computeCentroid(mems);

    // Single-member clusters → unassigned.
    if (mems.length === 1) {
      unassigned.push(memberPaths[0]);
      continue;
    }

    // Check per-member confidence.
    const qualifiedPaths: string[] = [];
    const qualifiedVecs: Float32Array[] = [];
    const unqualifiedPaths: string[] = [];

    for (let mi = 0; mi < mems.length; mi++) {
      const conf = cosineSimilarity(mems[mi], centroid);
      if (conf >= minConfidence) {
        qualifiedPaths.push(memberPaths[mi]);
        qualifiedVecs.push(mems[mi]);
      } else {
        unqualifiedPaths.push(memberPaths[mi]);
      }
    }

    for (const p of unqualifiedPaths) unassigned.push(p);

    // Need at least 2 qualified members to form a cluster.
    if (qualifiedPaths.length < 2) {
      for (const p of qualifiedPaths) unassigned.push(p);
      continue;
    }

    // Extract top terms and derive folder name.
    const topTerms = extractTopTerms(
      clusterInputGroups[ci],
      clusterInputGroups,
      3,
      corpusStopWords
    );
    const folder = deriveFolderName(
      topTerms.length > 0 ? topTerms : ["cluster"],
      usedFolders
    );
    usedFolders.add(folder);

    const finalCentroid = computeCentroid(qualifiedVecs);

    clusterResults.push({
      folder,
      centroid: finalCentroid,
      topTerms,
      memberPaths: qualifiedPaths,
    });

    // Record assignments.
    for (let mi = 0; mi < qualifiedPaths.length; mi++) {
      const conf = cosineSimilarity(qualifiedVecs[mi], finalCentroid);
      assignments.set(qualifiedPaths[mi], { folder, confidence: conf });
    }
  }

  return { clusters: clusterResults, assignments, unassigned };
}
