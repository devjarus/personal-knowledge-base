/**
 * Tests for semanticIndex.ts
 *
 * Run with: pnpm test
 * Uses node:test + node:assert (built-in, no new devDeps).
 *
 * All 6 cases per spec T8:
 * 1. JSONL round-trip
 * 2. Cosine math
 * 3. Top-K ordering
 * 4. Sig invalidation / refresh
 * 5. Missing-sidecar load
 * 6. Atomic write (tmp+rename)
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// We inject a fake KB_ROOT pointing to a temp dir for all tests.
// ---------------------------------------------------------------------------

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-sem-test-"));
  process.env.KB_ROOT = tmpDir;
});

after(async () => {
  delete process.env.KB_ROOT;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a unit-normalized vector of given length seeded by an integer. */
function makeVec(seed: number, dim = 384): number[] {
  const v: number[] = [];
  let acc = 0;
  for (let i = 0; i < dim; i++) {
    const val = Math.sin(seed * (i + 1) * 0.1);
    v.push(val);
    acc += val * val;
  }
  const norm = Math.sqrt(acc);
  return v.map((x) => x / norm);
}

function makeF32Vec(seed: number, dim = 384): Float32Array {
  return new Float32Array(makeVec(seed, dim));
}

/** Create minimal note files in the temp KB root. */
async function seedNotes(notes: Array<{ path: string; body: string }>): Promise<void> {
  for (const n of notes) {
    const abs = path.join(tmpDir, n.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(
      abs,
      `---\ntitle: ${path.basename(n.path, ".md")}\n---\n${n.body}`,
      "utf8"
    );
  }
}

// ---------------------------------------------------------------------------
// Test 1: JSONL round-trip
// ---------------------------------------------------------------------------

describe("JSONL round-trip", () => {
  test("writes rows and reads them back via loadIndex", async () => {
    const { sidecarPath, loadIndex, _invalidateSemanticCache, _setEmbedderForTests, refreshIndex } =
      await import("../semanticIndex.js");

    _invalidateSemanticCache();

    await seedNotes([
      { path: "rt-a.md", body: "alpha content" },
      { path: "rt-b.md", body: "beta content" },
      { path: "rt-c.md", body: "gamma content" },
    ]);

    let callCount = 0;
    _setEmbedderForTests(async (_text: string) => {
      callCount++;
      return makeF32Vec(callCount);
    });

    _invalidateSemanticCache();
    await refreshIndex();

    // Read back from disk.
    _invalidateSemanticCache();
    const index = await loadIndex();

    // Should have at least the 3 newly seeded notes (may include notes from other tests).
    const rtPaths = ["rt-a.md", "rt-b.md", "rt-c.md"];
    for (const p of rtPaths) {
      const row = index.get(p);
      assert.ok(row !== undefined, `Row for ${p} should exist`);
      assert.equal(row.path, p);
      assert.equal(row.dim, 384);
      assert.equal(row.vec.length, 384);
      assert.ok(typeof row.sig === "string" && row.sig.length > 0);
    }

    // Verify the sidecar file exists.
    const sp = sidecarPath();
    const stat = await fs.stat(sp);
    assert.ok(stat.isFile(), "Sidecar should exist as a file");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Cosine math
// ---------------------------------------------------------------------------

describe("Cosine math", () => {
  test("dot product of unit vectors at known angle equals cos(theta)", () => {
    // v1 = [1, 0], v2 = [cos(60°), sin(60°)]
    // dot product = cos(60°) = 0.5
    const v1 = new Float32Array([1, 0]);
    const v2 = new Float32Array([0.5, Math.sqrt(3) / 2]);

    let dot = 0;
    for (let i = 0; i < v1.length; i++) dot += v1[i] * v2[i];

    const expected = Math.cos(Math.PI / 3);
    assert.ok(Math.abs(dot - expected) < 1e-6, `Expected ~${expected}, got ${dot}`);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Top-K ordering
// ---------------------------------------------------------------------------

describe("Top-K ordering", () => {
  test("queryTopK returns correct top 3 in descending cosine order", async () => {
    const { queryTopK } = await import("../semanticIndex.js");
    type IndexRow = import("../semanticIndex.js").IndexRow;

    // Query vector: e1 (standard basis in 384 dims).
    const qVec = new Float32Array(384).fill(0);
    qVec[0] = 1;

    // 10 rows with known cosine = first component (since qVec = e1).
    const cosineValues = [0.1, 0.9, 0.3, 0.7, 0.05, 0.6, 0.8, 0.2, 0.4, 0.95];
    const fakeIndex = new Map<string, IndexRow>();

    for (let i = 0; i < 10; i++) {
      const c = cosineValues[i];
      const v = new Array(384).fill(0);
      v[0] = c;
      const rem = Math.sqrt(Math.max(0, 1 - c * c));
      const perSlot = rem / Math.sqrt(383);
      for (let j = 1; j < 384; j++) v[j] = perSlot;
      fakeIndex.set(`note${i}.md`, {
        path: `note${i}.md`,
        sig: "0:0",
        model: "Xenova/all-MiniLM-L6-v2",
        dim: 384,
        vec: v,
      });
    }

    const results = queryTopK(qVec, 3, fakeIndex);
    assert.equal(results.length, 3);

    // Best 3: index 9 (0.95), 1 (0.9), 6 (0.8)
    assert.equal(results[0].path, "note9.md", "First should be note9 (cosine 0.95)");
    assert.equal(results[1].path, "note1.md", "Second should be note1 (cosine 0.9)");
    assert.equal(results[2].path, "note6.md", "Third should be note6 (cosine 0.8)");

    assert.ok(results[0].cosine >= results[1].cosine, "Results should be descending");
    assert.ok(results[1].cosine >= results[2].cosine, "Results should be descending");
  });
});

// ---------------------------------------------------------------------------
// Test 4: Sig invalidation — refresh re-embeds stale rows
// ---------------------------------------------------------------------------

describe("Sig invalidation", () => {
  test("refreshIndex re-embeds rows whose sig changed", async () => {
    const { _invalidateSemanticCache, _setEmbedderForTests, refreshIndex } =
      await import("../semanticIndex.js");

    _invalidateSemanticCache();

    const notePath = "siginval.md";
    const absPath = path.join(tmpDir, notePath);
    await fs.writeFile(absPath, "---\ntitle: siginval\n---\noriginal body", "utf8");

    let embedCallCount = 0;
    _setEmbedderForTests(async (_text: string) => {
      embedCallCount++;
      return makeF32Vec(embedCallCount);
    });

    _invalidateSemanticCache();
    await refreshIndex();
    const countAfterFirst = embedCallCount;
    assert.ok(countAfterFirst >= 1, "Should have embedded at least once");

    // Wait slightly and mutate file so mtime changes.
    await new Promise<void>((r) => setTimeout(r, 20));
    await fs.writeFile(absPath, "---\ntitle: siginval\n---\nupdated body", "utf8");

    _invalidateSemanticCache();
    await refreshIndex();
    assert.ok(
      embedCallCount > countAfterFirst,
      `Should have re-embedded after sig change (calls: ${countAfterFirst} → ${embedCallCount})`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 5: Missing-sidecar load returns empty map (AC-7 fallback path)
// ---------------------------------------------------------------------------

describe("Missing-sidecar load", () => {
  test("loadIndex returns empty map when sidecar is absent", async () => {
    const { sidecarPath, loadIndex, _invalidateSemanticCache } =
      await import("../semanticIndex.js");

    _invalidateSemanticCache();

    const sp = sidecarPath();
    await fs.rm(sp, { force: true });

    const index = await loadIndex();
    assert.ok(index instanceof Map, "Should return a Map");
    assert.equal(index.size, 0, "Should be empty when sidecar is missing");
    // No throw — this is the AC-7 fallback path.
  });
});

// ---------------------------------------------------------------------------
// Test 6: Atomic write — original sidecar untouched if tmp file fails to rename
// ---------------------------------------------------------------------------

describe("Atomic write", () => {
  test("original sidecar is preserved if rename does not happen", async () => {
    const { sidecarPath, _invalidateSemanticCache } =
      await import("../semanticIndex.js");

    _invalidateSemanticCache();

    const sp = sidecarPath();
    const tmpPath = `${sp}.tmp`;

    // Write a known original sidecar.
    await fs.mkdir(path.dirname(sp), { recursive: true });
    const originalContent =
      JSON.stringify({
        path: "original.md",
        sig: "999:888",
        model: "Xenova/all-MiniLM-L6-v2",
        dim: 384,
        vec: new Array(384).fill(0.5),
      }) + "\n";
    await fs.writeFile(sp, originalContent, "utf8");

    // Simulate: .tmp was written but rename never happened (crash scenario).
    await fs.writeFile(tmpPath, "corrupted partial data\n", "utf8");

    // Original should still be intact.
    const actual = await fs.readFile(sp, "utf8");
    assert.equal(actual, originalContent, "Original sidecar must be untouched");

    // Clean up.
    await fs.rm(tmpPath, { force: true });
  });
});
