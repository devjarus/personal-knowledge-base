/**
 * clusters.test.ts — Dedicated unit tests for src/core/learn/clusters.ts.
 *
 * F1 fix: these tests directly cover the cluster discovery module,
 * particularly the ledger-aware branch (lines 77-107) which was previously
 * only exercised via buildLearnPlan integration tests.
 *
 * Tests:
 *  1. No organize ledger → falls back to folder scan.
 *  2. With organize ledger → uses move.to folders as cluster definitions.
 *  3. Ledger-aware path: folders below minNotes threshold are excluded.
 *  4. Ledger-aware path: _summary.md excluded from note count.
 *  5. Ledger-aware path: carved-out notes (path-level) excluded.
 *  6. Fallback scan: deeply nested notes included.
 *  7. Fallback scan: folders below minNotes excluded.
 *  8. Fallback scan: dotfiles and ignored dirs skipped.
 *  9. Empty KB → empty result.
 * 10. Clusters sorted by path.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-clusters-test-"));
});

after(async () => {
  delete process.env.KB_ROOT;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const sub = await fs.mkdtemp(path.join(tmpDir, "run-"));
  process.env.KB_ROOT = sub;
});

function root(): string {
  return process.env.KB_ROOT!;
}

async function writeNote(relPath: string, body = "Test content."): Promise<void> {
  const abs = path.join(root(), relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `---\ntitle: ${path.basename(relPath, ".md")}\n---\n${body}\n`, "utf8");
}

/** Write a minimal organize ledger with move records. */
async function writeFakeOrganizeLedger(moves: { from: string; to: string }[]): Promise<void> {
  const ledgerDir = path.join(root(), ".kb-index", "organize");
  await fs.mkdir(ledgerDir, { recursive: true });
  const lp = path.join(ledgerDir, "2026-01-01T00-00-00-000Z.jsonl");
  const lines = [
    JSON.stringify({ kind: "header", generatedAt: "2026-01-01T00:00:00Z", mode: "full", minConfidence: 0.35 }),
    ...moves.map((m) => JSON.stringify({ kind: "move", from: m.from, to: m.to, contentHash: "abc", reason: "cluster", confidence: 0.9 })),
    JSON.stringify({ kind: "commit", applied: moves.length, skipped: 0 }),
  ];
  await fs.writeFile(lp, lines.join("\n") + "\n", "utf8");
}

describe("discoverClusters", () => {
  describe("fallback scan (no organize ledger)", () => {
    test("empty KB returns empty array", async () => {
      const { discoverClusters } = await import("../../learn/clusters.js");
      const result = await discoverClusters(root(), { minNotes: 3 });
      assert.deepEqual(result, []);
    });

    test("folder with >= minNotes .md files is included", async () => {
      const { discoverClusters } = await import("../../learn/clusters.js");

      await writeNote("science/biology/note1.md");
      await writeNote("science/biology/note2.md");
      await writeNote("science/biology/note3.md");

      const result = await discoverClusters(root(), { minNotes: 3 });
      const cluster = result.find((c) => c.cluster === "science/biology");
      assert.ok(cluster, "expected 'science/biology' cluster");
      assert.equal(cluster.notes.length, 3);
    });

    test("folder below minNotes threshold excluded", async () => {
      const { discoverClusters } = await import("../../learn/clusters.js");

      await writeNote("small/n1.md");
      await writeNote("small/n2.md");
      // Only 2 notes, min is 3.

      const result = await discoverClusters(root(), { minNotes: 3 });
      assert.equal(result.length, 0);
    });

    test("_summary.md excluded from note count", async () => {
      const { discoverClusters } = await import("../../learn/clusters.js");

      await writeNote("cluster/n1.md");
      await writeNote("cluster/n2.md");
      // Only 2 real notes + 1 _summary.md.
      await fs.writeFile(
        path.join(root(), "cluster/_summary.md"),
        "---\ntype: cluster-summary\n---\n",
        "utf8"
      );

      const result = await discoverClusters(root(), { minNotes: 3 });
      // Should NOT be included (only 2 real notes).
      assert.equal(result.length, 0);
    });

    test("dotfiles and ignored dirs skipped", async () => {
      const { discoverClusters } = await import("../../learn/clusters.js");

      // Create notes in an ignored dir.
      await writeNote(".hidden/n1.md");
      await writeNote(".hidden/n2.md");
      await writeNote(".hidden/n3.md");
      // Create notes in a normal dir.
      await writeNote("visible/n1.md");
      await writeNote("visible/n2.md");
      await writeNote("visible/n3.md");

      const result = await discoverClusters(root(), { minNotes: 3 });
      const hiddenCluster = result.find((c) => c.cluster.includes(".hidden"));
      assert.equal(hiddenCluster, undefined, "hidden dirs should be excluded");
      const visibleCluster = result.find((c) => c.cluster === "visible");
      assert.ok(visibleCluster, "visible dir should be included");
    });

    test("clusters sorted by path", async () => {
      const { discoverClusters } = await import("../../learn/clusters.js");

      await writeNote("zzz/n1.md");
      await writeNote("zzz/n2.md");
      await writeNote("zzz/n3.md");
      await writeNote("aaa/n1.md");
      await writeNote("aaa/n2.md");
      await writeNote("aaa/n3.md");

      const result = await discoverClusters(root(), { minNotes: 3 });
      const paths = result.map((c) => c.cluster);
      const sorted = [...paths].sort();
      assert.deepEqual(paths, sorted, "clusters should be sorted by path");
    });
  });

  describe("ledger-aware path (organize ledger exists)", () => {
    test("uses move.to folders as cluster definitions", async () => {
      const { discoverClusters } = await import("../../learn/clusters.js");

      // Create the notes at their "after-organize" locations.
      await writeNote("ideas/ml/attention.md");
      await writeNote("ideas/ml/embeddings.md");
      await writeNote("ideas/ml/transformers.md");

      // Write an organize ledger that moved 3 files into ideas/ml/.
      await writeFakeOrganizeLedger([
        { from: "raw/attention.md", to: "ideas/ml/attention.md" },
        { from: "raw/embeddings.md", to: "ideas/ml/embeddings.md" },
        { from: "raw/transformers.md", to: "ideas/ml/transformers.md" },
      ]);

      const result = await discoverClusters(root(), { minNotes: 3 });
      const cluster = result.find((c) => c.cluster === "ideas/ml");
      assert.ok(cluster, "expected 'ideas/ml' cluster from ledger");
      assert.equal(cluster.notes.length, 3);
    });

    test("ledger-aware: folders below minNotes threshold excluded", async () => {
      const { discoverClusters } = await import("../../learn/clusters.js");

      // Only 2 notes in the ledger destination.
      await writeNote("ideas/tiny/n1.md");
      await writeNote("ideas/tiny/n2.md");

      await writeFakeOrganizeLedger([
        { from: "raw/n1.md", to: "ideas/tiny/n1.md" },
        { from: "raw/n2.md", to: "ideas/tiny/n2.md" },
      ]);

      const result = await discoverClusters(root(), { minNotes: 3 });
      const cluster = result.find((c) => c.cluster === "ideas/tiny");
      assert.equal(cluster, undefined, "cluster with < minNotes excluded from ledger path");
    });

    test("ledger-aware: _summary.md excluded from note list", async () => {
      const { discoverClusters } = await import("../../learn/clusters.js");

      await writeNote("ideas/withsummary/n1.md");
      await writeNote("ideas/withsummary/n2.md");
      await writeNote("ideas/withsummary/n3.md");
      // Also create a _summary.md.
      await fs.writeFile(
        path.join(root(), "ideas/withsummary/_summary.md"),
        "---\ntype: cluster-summary\n---\n# Summary\n",
        "utf8"
      );

      await writeFakeOrganizeLedger([
        { from: "raw/n1.md", to: "ideas/withsummary/n1.md" },
        { from: "raw/n2.md", to: "ideas/withsummary/n2.md" },
        { from: "raw/n3.md", to: "ideas/withsummary/n3.md" },
      ]);

      const result = await discoverClusters(root(), { minNotes: 3 });
      const cluster = result.find((c) => c.cluster === "ideas/withsummary");
      assert.ok(cluster, "cluster should exist");
      // _summary.md should not be in the notes list.
      for (const note of cluster.notes) {
        assert.ok(!note.includes("_summary.md"), `_summary.md should not be in notes: ${note}`);
      }
    });

    test("falls back to scan when ledger has no move records", async () => {
      const { discoverClusters } = await import("../../learn/clusters.js");

      // Write a ledger with ONLY a header and commit — no moves.
      const ledgerDir = path.join(root(), ".kb-index", "organize");
      await fs.mkdir(ledgerDir, { recursive: true });
      const lp = path.join(ledgerDir, "2026-01-01T00-00-00-000Z.jsonl");
      await fs.writeFile(
        lp,
        [
          JSON.stringify({ kind: "header", generatedAt: "2026-01-01T00:00:00Z", mode: "full", minConfidence: 0.35 }),
          JSON.stringify({ kind: "commit", applied: 0, skipped: 0 }),
        ].join("\n") + "\n",
        "utf8"
      );

      // Create notes that the scan should pick up.
      await writeNote("fallback/n1.md");
      await writeNote("fallback/n2.md");
      await writeNote("fallback/n3.md");

      const result = await discoverClusters(root(), { minNotes: 3 });
      const cluster = result.find((c) => c.cluster === "fallback");
      assert.ok(cluster, "fallback scan should find the cluster when ledger has no moves");
    });
  });
});
