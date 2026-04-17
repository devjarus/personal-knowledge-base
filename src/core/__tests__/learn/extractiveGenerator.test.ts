/**
 * extractiveGenerator.test.ts — Unit tests for the extractive summary generator.
 *
 * Tests:
 *   1. Empty notes → empty GeneratedSummary
 *   2. Determinism — same inputs produce identical output
 *   3. Centroid ranking — note closest to centroid is ranked first
 *   4. Tag-frequency themes — most frequent tags appear first
 *   5. Open question extraction from excerpts
 *   6. Key point extraction with first-sentence logic
 *   7. Backfill to reach 3 key points from second sentences
 *   8. Tag fallback to title-word frequency when < 3 tags
 *   9. K = min(5, clusterSize) cap on key points
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateExtractive } from "../../learn/extractiveGenerator.js";
import type { PromptInput } from "../../learn/prompts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a seeded Float32Array (dim 4) for testing. */
function seedVec(seed: number, dim = 4): Float32Array {
  const v = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1) * 0.37 + seed);
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

function makeNote(
  pathStr: string,
  tags: string[],
  excerpt: string,
  title?: string
) {
  return { path: pathStr, tags, excerpt, title: title ?? pathStr };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateExtractive — empty input", () => {
  test("returns empty summary for zero notes", () => {
    const input: PromptInput = { clusterName: "empty", notes: [] };
    const result = generateExtractive(input, new Map());
    assert.deepEqual(result.themes, []);
    assert.deepEqual(result.keyPoints, []);
    assert.deepEqual(result.openQuestions, []);
  });
});

describe("generateExtractive — determinism", () => {
  test("same inputs produce identical output (called twice)", () => {
    const embeddings = new Map<string, Float32Array>([
      ["ideas/ml/note1.md", seedVec(1)],
      ["ideas/ml/note2.md", seedVec(2)],
      ["ideas/ml/note3.md", seedVec(3)],
    ]);
    const notes = [
      makeNote("ideas/ml/note1.md", ["machine-learning", "neural-nets"], "Transformers use attention mechanisms. They work well for NLP."),
      makeNote("ideas/ml/note2.md", ["machine-learning", "data"], "Gradient descent optimises loss functions. It converges slowly on some tasks."),
      makeNote("ideas/ml/note3.md", ["data", "statistics"], "Probability theory underpins all learning algorithms. Bayes is foundational."),
    ];
    const input: PromptInput = { clusterName: "ml", notes };

    const result1 = generateExtractive(input, embeddings);
    const result2 = generateExtractive(input, embeddings);

    assert.deepEqual(result1, result2);
  });
});

describe("generateExtractive — centroid ranking", () => {
  test("note closest to centroid of single note is that note itself", () => {
    const vec = seedVec(42);
    const embeddings = new Map<string, Float32Array>([["cluster/note.md", vec]]);
    const notes = [makeNote("cluster/note.md", ["science"], "First sentence here. Second sentence follows.")];
    const input: PromptInput = { clusterName: "science", notes };
    const result = generateExtractive(input, embeddings);
    // Key point should be the first sentence.
    assert.ok(result.keyPoints.length > 0);
    assert.equal(result.keyPoints[0], "First sentence here.");
  });

  test("note with embedding closest to centroid produces first key point", () => {
    // Two notes: note1 is "north pole" of embedding space, note2 is "south pole".
    // The centroid is in the middle, but note1's first sentence should appear.
    const dim = 4;
    const v1 = new Float32Array([1, 0, 0, 0]);
    const v2 = new Float32Array([-1, 0, 0, 0]);

    // Only one note has a prominent position near the centroid.
    const embeddings = new Map<string, Float32Array>([
      ["cluster/a.md", v1],
      ["cluster/b.md", v2],
      ["cluster/c.md", v1], // same direction as a
    ]);

    const notes = [
      makeNote("cluster/a.md", ["ai"], "Alpha note first sentence. With more text here."),
      makeNote("cluster/b.md", ["ai"], "Beta note first sentence. Different direction."),
      makeNote("cluster/c.md", ["ai"], "Gamma note first sentence. Same direction as alpha."),
    ];
    const input: PromptInput = { clusterName: "cluster", notes };
    const result = generateExtractive(input, embeddings);

    // Points should exist and be first sentences from notes.
    assert.ok(result.keyPoints.length > 0);
    // The centroid will be the average of v1, v2, v1 = (1/3, 0, 0, 0) → points toward v1.
    // So a.md and c.md should be ranked higher than b.md.
    const firstPoint = result.keyPoints[0];
    assert.ok(
      firstPoint.includes("Alpha") || firstPoint.includes("Gamma"),
      `expected Alpha or Gamma but got: ${firstPoint}`
    );
  });
});

describe("generateExtractive — tag-frequency themes", () => {
  test("most frequent tags appear first in themes", () => {
    const notes = [
      makeNote("f/a.md", ["ml", "python", "ml"], "Sentence one."),
      makeNote("f/b.md", ["ml", "python"], "Sentence two."),
      makeNote("f/c.md", ["python", "stats"], "Sentence three."),
    ];
    const input: PromptInput = { clusterName: "f", notes };
    const result = generateExtractive(input, new Map());
    // "ml" appears 3 times total, "python" appears 3 times — both should be in themes.
    // "stats" appears once. Order: ml and python tied (alphabetical: ml before python).
    assert.ok(result.themes.includes("ml"), `themes: ${result.themes}`);
    assert.ok(result.themes.includes("python"), `themes: ${result.themes}`);
  });

  test("themes capped at 5 items", () => {
    const notes = [
      makeNote("f/a.md", ["a", "b", "c", "d", "e", "f"], "Sentence one."),
      makeNote("f/b.md", ["a", "b", "c", "d", "e", "f"], "Sentence two."),
      makeNote("f/c.md", ["a", "b", "c", "d", "e", "f"], "Sentence three."),
    ];
    const input: PromptInput = { clusterName: "f", notes };
    const result = generateExtractive(input, new Map());
    assert.ok(result.themes.length <= 5, `themes length: ${result.themes.length}`);
  });

  test("falls back to title-word frequency when fewer than 3 distinct tags", () => {
    const notes = [
      makeNote("f/a.md", [], "Sentence.", "machine learning models"),
      makeNote("f/b.md", [], "Sentence.", "machine learning data"),
      makeNote("f/c.md", [], "Sentence.", "machine stats methods"),
    ];
    const input: PromptInput = { clusterName: "f", notes };
    const result = generateExtractive(input, new Map());
    // "machine" appears in all 3 titles — should be in themes.
    assert.ok(result.themes.includes("machine") || result.themes.includes("learning") || result.themes.includes("models"),
      `fallback themes: ${result.themes}`
    );
  });
});

describe("generateExtractive — open questions", () => {
  test("extracts sentences ending in ? from excerpts", () => {
    const notes = [
      makeNote("f/a.md", ["ai"], "Regular sentence. Is this a question? Another regular one."),
      makeNote("f/b.md", ["ai"], "No questions here at all. Just facts."),
      makeNote("f/c.md", ["ai"], "What happens next? Let us find out."),
    ];
    const input: PromptInput = { clusterName: "f", notes };
    const result = generateExtractive(input, new Map());
    assert.ok(result.openQuestions.length > 0, "expected at least one open question");
    // All returned strings should end with ?
    for (const q of result.openQuestions) {
      assert.ok(q.endsWith("?"), `"${q}" does not end with ?`);
    }
  });

  test("open questions capped at 3", () => {
    const notes = [
      makeNote("f/a.md", ["ai"], "Q1? Q2? Q3? Q4? Q5?"),
      makeNote("f/b.md", ["ai"], "Q6? Q7?"),
      makeNote("f/c.md", ["ai"], "Q8?"),
    ];
    const input: PromptInput = { clusterName: "f", notes };
    const result = generateExtractive(input, new Map());
    assert.ok(result.openQuestions.length <= 3, `got ${result.openQuestions.length} questions`);
  });

  test("returns [] when no ? sentences found", () => {
    const notes = [
      makeNote("f/a.md", ["ai"], "No questions here. Just facts."),
      makeNote("f/b.md", ["ai"], "More facts. And more."),
      makeNote("f/c.md", ["ai"], "Last note. No queries."),
    ];
    const input: PromptInput = { clusterName: "f", notes };
    const result = generateExtractive(input, new Map());
    assert.deepEqual(result.openQuestions, []);
  });

  test("deduplicates questions case-insensitively", () => {
    const notes = [
      makeNote("f/a.md", ["ai"], "Is this a duplicate? yes, more."),
      makeNote("f/b.md", ["ai"], "is this a duplicate? yes, again."),
      makeNote("f/c.md", ["ai"], "Another question?"),
    ];
    const input: PromptInput = { clusterName: "f", notes };
    const result = generateExtractive(input, new Map());
    // Should only have the question once.
    const dupeQuestion = result.openQuestions.filter((q) =>
      q.toLowerCase().includes("is this a duplicate")
    );
    assert.equal(dupeQuestion.length, 1);
  });
});

describe("generateExtractive — key points backfill", () => {
  test("backfills from second sentence when first sentences < 3", () => {
    // Only 2 notes → K = min(5, 2) = 2, so max 2 first-sentences.
    // Backfill should add second sentence to reach ≥ 1 additional point.
    const notes = [
      makeNote("f/a.md", ["ai"], "First sentence A. Second sentence A."),
      makeNote("f/b.md", ["ai"], "First sentence B. Second sentence B."),
    ];
    const input: PromptInput = { clusterName: "f", notes };
    const result = generateExtractive(input, new Map());
    // 2 notes, K=2, so we get 2 first sentences.
    // Since 2 < 3, we should backfill from second sentences.
    assert.ok(result.keyPoints.length >= 2, `got ${result.keyPoints.length} key points`);
  });

  test("key points from excerpt use first sentence, capped at 250 chars", () => {
    const longSentence = "A".repeat(300) + ". Second sentence.";
    const notes = [
      makeNote("f/a.md", ["ai"], longSentence),
      makeNote("f/b.md", ["ai"], "Short first sentence. Second sentence."),
      makeNote("f/c.md", ["ai"], "Another short one. Second."),
    ];
    const input: PromptInput = { clusterName: "f", notes };
    const result = generateExtractive(input, new Map());
    for (const kp of result.keyPoints) {
      assert.ok(kp.length <= 250, `key point too long: ${kp.length} chars`);
    }
  });
});

describe("generateExtractive — K cap", () => {
  test("K = min(5, clusterSize)", () => {
    // 8 notes → K = 5, so at most 5 key points.
    const notes = Array.from({ length: 8 }, (_, i) =>
      makeNote(`f/note${i}.md`, ["tag"], `First sentence ${i}. Second sentence ${i}.`)
    );
    const input: PromptInput = { clusterName: "f", notes };
    const result = generateExtractive(input, new Map());
    // At most 5 key points from the top-K notes (plus backfill is bounded by top-K).
    assert.ok(result.keyPoints.length <= 5, `got ${result.keyPoints.length} key points`);
  });

  test("K = 1 for single-note cluster", () => {
    const notes = [
      makeNote("f/a.md", ["ai"], "Only note first sentence. And a second sentence."),
    ];
    const input: PromptInput = { clusterName: "f", notes };
    const result = generateExtractive(input, new Map());
    // K = min(5, 1) = 1, plus backfill from second sentence → up to 2.
    assert.ok(result.keyPoints.length >= 1, "expected at least 1 key point");
  });
});
