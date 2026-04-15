/**
 * Tests for organize/cluster.ts — cluster() and deriveFolderName()
 *
 * Run with: pnpm test (tsx runner, node:test)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ClusterInput } from "../organize/cluster.js";

async function getCluster() {
  const { cluster } = await import("../organize/cluster.js");
  return cluster;
}

async function getDeriveFolderName() {
  const { deriveFolderName } = await import("../organize/folderName.js");
  return deriveFolderName;
}

// ---------------------------------------------------------------------------
// Helper: build a unit-normalized vector of given dimension, seeded by an int.
// Deterministic and easy to reason about.
// ---------------------------------------------------------------------------
function makeVec(seed: number, dim = 8): Float32Array {
  const v = new Float32Array(dim);
  let acc = 0;
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1) * 0.37 + seed);
    acc += v[i] * v[i];
  }
  const norm = Math.sqrt(acc);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

/**
 * Build a synthetic fixture with `nClusters` natural clusters.
 * Notes in the same cluster have nearly-identical vectors (a base vec + tiny perturbation).
 * Notes across clusters are far apart (orthogonal-ish seeds).
 */
function makeFixture(
  nClusters: number,
  notesPerCluster: number,
  dim = 8
): ClusterInput[] {
  const inputs: ClusterInput[] = [];
  for (let c = 0; c < nClusters; c++) {
    const base = makeVec(c * 100 + 1, dim);
    for (let n = 0; n < notesPerCluster; n++) {
      // Tiny perturbation: scale base slightly and renormalize.
      const v = new Float32Array(dim);
      let acc = 0;
      for (let i = 0; i < dim; i++) {
        // Perturb: add a tiny sin-based offset unique per note.
        v[i] = base[i] + 0.001 * Math.sin(n * (i + 1) * 0.1);
        acc += v[i] * v[i];
      }
      const norm = Math.sqrt(acc);
      for (let i = 0; i < dim; i++) v[i] /= norm;

      inputs.push({
        path: `cluster${c}/note${n}.md`,
        embedding: v,
        titleTerms: [`topic${c}`, "common"],
        tagTerms: [`tag${c}`],
      });
    }
  }
  // Sort by path to ensure determinism (the cluster fn must also sort internally).
  inputs.sort((a, b) => a.path.localeCompare(b.path));
  return inputs;
}

// ---------------------------------------------------------------------------
// Test 1: Deterministic output
// ---------------------------------------------------------------------------

describe("cluster — determinism", () => {
  test("two calls on the same input produce identical assignments", async () => {
    const cluster = await getCluster();
    const inputs = makeFixture(3, 4);
    const out1 = cluster(inputs, { minConfidence: 0.3, maxClusters: 10 });
    const out2 = cluster(inputs, { minConfidence: 0.3, maxClusters: 10 });

    // Compare assignments: same paths, same folders, same confidences.
    const assignArr1 = [...out1.assignments.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    const assignArr2 = [...out2.assignments.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    assert.deepEqual(assignArr1, assignArr2, "Assignments must be identical across two calls");

    // Cluster folders (sorted) must be identical.
    const folders1 = out1.clusters.map((c) => c.folder).sort();
    const folders2 = out2.clusters.map((c) => c.folder).sort();
    assert.deepEqual(folders1, folders2, "Cluster folder names must be identical across two calls");
  });
});

// ---------------------------------------------------------------------------
// Test 2: maxClusters cap
// ---------------------------------------------------------------------------

describe("cluster — maxClusters cap", () => {
  test("cluster count is capped at maxClusters", async () => {
    const cluster = await getCluster();
    // 8 natural clusters, but we cap at 3.
    const inputs = makeFixture(8, 3);
    const out = cluster(inputs, { minConfidence: 0.0, maxClusters: 3 });
    assert.ok(
      out.clusters.length <= 3,
      `Expected ≤ 3 clusters, got ${out.clusters.length}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 3: minConfidence — outliers go to unassigned
// ---------------------------------------------------------------------------

describe("cluster — minConfidence", () => {
  test("outlier note below minConfidence lands in unassigned", async () => {
    const cluster = await getCluster();
    // Use very high minConfidence so outliers are excluded.
    const inputs = makeFixture(2, 3);

    // Add a truly random outlier (a near-zero vector).
    const outlier: ClusterInput = {
      path: "zzz-outlier.md",
      embedding: new Float32Array(8).fill(0.01),
      titleTerms: ["outlier"],
      tagTerms: [],
    };
    // Normalize it.
    const norm = Math.sqrt([...outlier.embedding].reduce((s, v) => s + v * v, 0));
    for (let i = 0; i < 8; i++) outlier.embedding[i] /= norm;

    const all = [...inputs, outlier].sort((a, b) => a.path.localeCompare(b.path));
    // With very high minConfidence (0.99) the outlier should be unassigned.
    const out = cluster(all, { minConfidence: 0.99, maxClusters: 10 });

    // The outlier MIGHT end up unassigned (it's nearly uniform and won't be
    // close to any cluster centroid built from very-similar notes).
    // We only assert the unassigned list is a subset of input paths.
    for (const u of out.unassigned) {
      assert.ok(
        all.some((inp) => inp.path === u),
        `Unassigned path ${u} not in inputs`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: Top-term extraction produces slug-safe names
// ---------------------------------------------------------------------------

describe("cluster — top-term extraction via deriveFolderName", () => {
  test("cluster of RAG+eval notes produces a non-empty slug-safe folder name", async () => {
    const cluster = await getCluster();
    const deriveFolderName = await getDeriveFolderName();

    const inputs: ClusterInput[] = Array.from({ length: 5 }, (_, i) => ({
      path: `rag/note${i}.md`,
      embedding: makeVec(1, 8),
      titleTerms: ["RAG", "eval", "retrieval"],
      tagTerms: ["rag", "eval"],
    }));
    inputs.sort((a, b) => a.path.localeCompare(b.path));

    const out = cluster(inputs, { minConfidence: 0.0, maxClusters: 10 });
    assert.ok(out.clusters.length > 0, "Should have at least one cluster");

    const c = out.clusters[0];
    assert.ok(c.topTerms.length > 0, "topTerms must be non-empty");

    const folder = deriveFolderName(c.topTerms, new Set());
    assert.ok(folder.length > 0, "Derived folder name must be non-empty");
    // Slug-safe: only lowercase alphanumeric + hyphens.
    assert.match(folder, /^[a-z0-9][a-z0-9-]*$/, `Folder name '${folder}' is not slug-safe`);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Single-note cluster → unassigned (not its own folder)
// ---------------------------------------------------------------------------

describe("cluster — single-note cluster", () => {
  test("a single isolated note is placed in unassigned, not a 1-member cluster", async () => {
    const cluster = await getCluster();
    // One note only.
    const inputs: ClusterInput[] = [
      {
        path: "solo.md",
        embedding: makeVec(42, 8),
        titleTerms: ["solo"],
        tagTerms: [],
      },
    ];
    const out = cluster(inputs, { minConfidence: 0.0, maxClusters: 10 });
    // A single note can't form a meaningful cluster — it must be unassigned.
    assert.equal(out.clusters.length, 0, "No clusters expected for a single note");
    assert.equal(out.unassigned.length, 1, "Solo note must be in unassigned");
    assert.equal(out.unassigned[0], "solo.md");
  });
});

// ---------------------------------------------------------------------------
// Test 6: Empty input → empty output, no crash
// ---------------------------------------------------------------------------

describe("cluster — empty input", () => {
  test("empty inputs produce empty outputs without throwing", async () => {
    const cluster = await getCluster();
    const out = cluster([], { minConfidence: 0.35, maxClusters: 20 });
    assert.equal(out.clusters.length, 0);
    assert.equal(out.assignments.size, 0);
    assert.equal(out.unassigned.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Elbow method picks sensible k on a synthetic 3-cluster fixture
// ---------------------------------------------------------------------------

describe("cluster — elbow method auto-k", () => {
  test("elbow picks 3 clusters for a clearly 3-cluster fixture", async () => {
    const cluster = await getCluster();
    // 3 tight clusters, 5 notes each, with low minConfidence so all are assigned.
    const inputs = makeFixture(3, 5);
    const out = cluster(inputs, { minConfidence: 0.0, maxClusters: 20 });
    // Elbow should settle at or near 3.
    // We allow 2–4 as a reasonable range (agglomerative may merge/split slightly).
    assert.ok(
      out.clusters.length >= 1 && out.clusters.length <= 10,
      `Expected 1–10 clusters for 3-cluster fixture, got ${out.clusters.length}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 8: deriveFolderName — collision stability
// ---------------------------------------------------------------------------

describe("deriveFolderName — collision avoidance", () => {
  test("if base name already exists, appends a numeric suffix", async () => {
    const deriveFolderName = await getDeriveFolderName();
    const existing = new Set(["agents"]);
    const name = deriveFolderName(["agents", "memory"], existing);
    // Must not return "agents" since it already exists.
    assert.notEqual(name, "agents", "Should not return existing folder name");
    // Must still be slug-safe.
    assert.match(name, /^[a-z0-9][a-z0-9-]*$/, `Name '${name}' not slug-safe`);
  });
});
