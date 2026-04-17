/**
 * buildLearnPlan.test.ts — Integration tests for buildLearnPlan().
 *
 * Tests:
 *   1. Empty KB → empty plan (no clusters)
 *   2. Single cluster with 5 notes → one entry, sources.length === 5, status === "new"
 *   3. Cluster under minNotes threshold (2 notes, min=3) → skipped
 *   4. Fresh status when existing _summary.md has matching sourceHashes + generator
 *   5. Stale status when sourceHashes differ
 *   6. Idempotency hash is sorted + stable (same sources, different discovery order)
 *   7. Carved-out folder (organize: false) → absent from plan
 *   8. Scoped mode (clusters opt) → only that cluster in plan
 *   9. --force overrides fresh status → stale
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Temp dir fixture
// ---------------------------------------------------------------------------

let tmpRoot: string;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kb-learn-plan-test-"));
});

after(async () => {
  delete process.env.KB_ROOT;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each test gets a fresh subdirectory.
  const sub = await fs.mkdtemp(path.join(tmpRoot, "run-"));
  process.env.KB_ROOT = sub;
  // Invalidate notes cache.
  const { _invalidateNotesCache } = await import("../../fs.js");
  _invalidateNotesCache();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kbRoot(): string {
  return process.env.KB_ROOT!;
}

async function writeNote(
  relPath: string,
  frontmatter: Record<string, unknown> = {},
  body = "Test body content with enough text to split into sentences."
): Promise<void> {
  const abs = path.join(kbRoot(), relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const fmLines = Object.entries(frontmatter).map(([k, v]) => {
    if (typeof v === "string") return `${k}: ${v}`;
    if (typeof v === "boolean") return `${k}: ${v}`;
    if (Array.isArray(v)) return `${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`;
    return `${k}: ${JSON.stringify(v)}`;
  });
  const content =
    fmLines.length > 0
      ? `---\n${fmLines.join("\n")}\n---\n${body}\n`
      : `${body}\n`;
  await fs.writeFile(abs, content, "utf8");
}

async function writeSummary(
  clusterPath: string,
  sourceHashes: string[],
  model = "extractive"
): Promise<void> {
  const summaryPath = path.join(kbRoot(), clusterPath, "_summary.md");
  const content = `---
type: cluster-summary
generator: kb-learn@0.1.0
cluster: ${clusterPath}
generatedAt: 2026-04-01T00:00:00Z
sourceCount: ${sourceHashes.length}
sourceHashes:
${sourceHashes.map((h) => `  - ${h}`).join("\n")}
model: ${model}
sources: []
organize: false
pinned: true
---
# Summary — test

## Themes
- Some theme

## Key points
- Some key point.

## Sources
`;
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, content, "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildLearnPlan — empty KB", () => {
  test("returns empty plan for KB with no notes", async () => {
    // KB_ROOT directory exists but has no notes.
    // noLlm: true so the test doesn't depend on Ollama availability.
    const { buildLearnPlan } = await import("../../learn.js");
    const plan = await buildLearnPlan({ kbRoot: kbRoot(), noLlm: true });

    assert.equal(plan.clusters.length, 0, "expected 0 clusters");
    assert.equal(plan.stats.total, 0);
    assert.equal(plan.stats.new, 0);
    assert.equal(plan.mode, "full");
    assert.equal(plan.generator, "extractive");
    assert.ok(plan.generatedAt, "generatedAt should be set");
  });
});

describe("buildLearnPlan — single cluster happy path", () => {
  test("5-note cluster → one entry with sources.length === 5 and status === 'new'", async () => {
    const folder = "ideas/ml";
    for (let i = 1; i <= 5; i++) {
      await writeNote(`${folder}/note${i}.md`, { tags: `["ml"]` }, `Content of note ${i}. More text here.`);
    }

    // noLlm: true so the test doesn't depend on Ollama availability.
    const { buildLearnPlan } = await import("../../learn.js");
    const plan = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3, noLlm: true });

    assert.equal(plan.clusters.length, 1, `expected 1 cluster but got ${plan.clusters.length}`);
    const cluster = plan.clusters[0];
    assert.equal(cluster.cluster, folder);
    assert.equal(cluster.sources.length, 5);
    assert.equal(cluster.sourceHashes.length, 5);
    assert.equal(cluster.status, "new");
    assert.equal(cluster.summaryPath, `${folder}/_summary.md`);
    assert.equal(cluster.generator, "extractive");
    // Sources should be sorted.
    assert.deepEqual(cluster.sources, [...cluster.sources].sort());
  });
});

describe("buildLearnPlan — below minNotes threshold", () => {
  test("2-note folder with minNotes=3 → skipped (not in active clusters)", async () => {
    const folder = "ideas/small";
    await writeNote(`${folder}/a.md`, {}, "First sentence. Second sentence.");
    await writeNote(`${folder}/b.md`, {}, "Another note. More content.");

    const { buildLearnPlan } = await import("../../learn.js");
    const plan = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3 });

    // The 2-note folder should produce a skipped cluster OR not appear at all.
    // Per discoverClusters: folders with < minNotes direct .md children are excluded.
    // So it should not appear in the plan clusters.
    const found = plan.clusters.find((c) => c.cluster === folder);
    if (found) {
      assert.equal(found.status, "skipped", "under-threshold cluster should be skipped");
    } else {
      assert.equal(plan.clusters.length, 0, "no eligible clusters expected");
    }
    assert.equal(plan.stats.new, 0);
  });

  test("3-note folder with minNotes=3 → eligible (included)", async () => {
    const folder = "ideas/medium";
    for (let i = 1; i <= 3; i++) {
      await writeNote(`${folder}/note${i}.md`, {}, `Content ${i}. Second sentence.`);
    }

    const { buildLearnPlan } = await import("../../learn.js");
    const plan = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3 });

    const cluster = plan.clusters.find((c) => c.cluster === folder);
    assert.ok(cluster, "3-note cluster should be in plan");
    if (cluster) {
      assert.notEqual(cluster.status, "skipped");
    }
  });
});

describe("buildLearnPlan — idempotency", () => {
  test("fresh status when existing _summary.md has matching sourceHashes and generator", async () => {
    const folder = "ideas/fresh";
    for (let i = 1; i <= 3; i++) {
      await writeNote(`${folder}/note${i}.md`, {}, `Content for note ${i}. Enough text.`);
    }

    // noLlm: true on both runs so the generator tier is consistently "extractive"
    // and doesn't depend on Ollama availability.
    const { buildLearnPlan } = await import("../../learn.js");
    const plan1 = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3, noLlm: true });
    const cluster1 = plan1.clusters.find((c) => c.cluster === folder);
    assert.ok(cluster1, "cluster should be found in first plan");
    assert.equal(cluster1!.status, "new");

    // Write a summary with matching hashes.
    await writeSummary(folder, cluster1!.sourceHashes, "extractive");

    // Second run — should be fresh.
    const { _invalidateNotesCache } = await import("../../fs.js");
    _invalidateNotesCache();
    const plan2 = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3, noLlm: true });
    const cluster2 = plan2.clusters.find((c) => c.cluster === folder);
    assert.ok(cluster2, "cluster should still appear in second plan");
    assert.equal(cluster2!.status, "fresh");
    assert.equal(plan2.stats.fresh, 1);
    assert.equal(plan2.stats.new, 0);
  });

  test("stale status when sourceHashes differ from existing summary", async () => {
    const folder = "ideas/stale";
    for (let i = 1; i <= 3; i++) {
      await writeNote(`${folder}/note${i}.md`, {}, `Content for note ${i}.`);
    }

    // Write a summary with WRONG hashes.
    await writeSummary(folder, ["deadbeef", "cafebabe", "00001234"], "extractive");

    const { buildLearnPlan } = await import("../../learn.js");
    const plan = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3 });
    const cluster = plan.clusters.find((c) => c.cluster === folder);
    assert.ok(cluster, "cluster should be found");
    assert.equal(cluster!.status, "stale");
    assert.equal(plan.stats.stale, 1);
  });

  test("sourceHashes are sorted and stable", async () => {
    const folder = "ideas/stable";
    await writeNote(`${folder}/z-note.md`, {}, "Z note content. Second sentence.");
    await writeNote(`${folder}/a-note.md`, {}, "A note content. Second sentence.");
    await writeNote(`${folder}/m-note.md`, {}, "M note content. Second sentence.");

    const { buildLearnPlan } = await import("../../learn.js");
    const plan = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3 });
    const cluster = plan.clusters.find((c) => c.cluster === folder);
    assert.ok(cluster, "cluster should be found");

    const hashes = cluster!.sourceHashes;
    const sorted = [...hashes].sort();
    assert.deepEqual(hashes, sorted, "sourceHashes should be sorted");
  });

  test("--force overrides fresh status to stale", async () => {
    const folder = "ideas/forced";
    for (let i = 1; i <= 3; i++) {
      await writeNote(`${folder}/note${i}.md`, {}, `Content ${i}.`);
    }

    const { buildLearnPlan } = await import("../../learn.js");
    // First run to get hashes.
    const plan1 = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3 });
    const cluster1 = plan1.clusters.find((c) => c.cluster === folder);
    assert.ok(cluster1);

    // Write matching summary.
    await writeSummary(folder, cluster1!.sourceHashes, "extractive");

    const { _invalidateNotesCache } = await import("../../fs.js");
    _invalidateNotesCache();

    // Run with force=true — should override fresh to stale.
    const plan2 = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3, force: true });
    const cluster2 = plan2.clusters.find((c) => c.cluster === folder);
    assert.ok(cluster2);
    assert.equal(cluster2!.status, "stale", "force should override fresh to stale");
  });
});

describe("buildLearnPlan — carve-outs", () => {
  test("folder with organize: false frontmatter note → source note excluded", async () => {
    const folder = "ideas/mixed";
    // 3 normal notes + 1 carved-out note.
    for (let i = 1; i <= 3; i++) {
      await writeNote(`${folder}/note${i}.md`, { tags: `["ai"]` }, `Content ${i}.`);
    }
    // Carved-out note.
    await writeNote(`${folder}/carved.md`, { organize: false }, "Carved out content.");

    const { buildLearnPlan } = await import("../../learn.js");
    const plan = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3 });
    const cluster = plan.clusters.find((c) => c.cluster === folder);
    assert.ok(cluster, "folder should be a cluster (3 valid notes)");
    // The carved-out note should not be in sources.
    assert.ok(
      !cluster!.sources.includes(`${folder}/carved.md`),
      "carved-out note should not appear in sources"
    );
    assert.equal(cluster!.sources.length, 3, "should have exactly 3 sources");
  });

  test("meta/ folder is excluded entirely (carve-out by path)", async () => {
    // Create notes in meta/ and a valid cluster.
    for (let i = 1; i <= 3; i++) {
      await writeNote(`meta/note${i}.md`, {}, `Meta content ${i}.`);
    }
    for (let i = 1; i <= 3; i++) {
      await writeNote(`ideas/valid/note${i}.md`, {}, `Valid content ${i}.`);
    }

    const { buildLearnPlan } = await import("../../learn.js");
    const plan = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3 });

    const metaCluster = plan.clusters.find((c) => c.cluster === "meta");
    assert.ok(!metaCluster, "meta/ cluster should not appear in plan");

    const validCluster = plan.clusters.find((c) => c.cluster === "ideas/valid");
    assert.ok(validCluster, "ideas/valid cluster should appear in plan");
  });
});

describe("buildLearnPlan — scoped mode", () => {
  test("clusters opt restricts plan to named cluster only", async () => {
    // Two clusters.
    for (let i = 1; i <= 3; i++) {
      await writeNote(`alpha/note${i}.md`, {}, `Alpha content ${i}.`);
      await writeNote(`beta/note${i}.md`, {}, `Beta content ${i}.`);
    }

    const { buildLearnPlan } = await import("../../learn.js");
    const plan = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3, clusters: ["alpha"] });

    assert.equal(plan.mode, "scoped");
    assert.equal(plan.clusters.length, 1, "should only have 1 cluster in scoped mode");
    assert.equal(plan.clusters[0].cluster, "alpha");
  });
});

describe("buildLearnPlan — integration with carve-outs (mixed cluster)", () => {
  test("integration: folder with mix of normal and pinned notes", async () => {
    const folder = "ideas/pinned-mix";
    for (let i = 1; i <= 4; i++) {
      await writeNote(`${folder}/note${i}.md`, {}, `Content ${i}. Second sentence here.`);
    }
    await writeNote(`${folder}/pinned.md`, { pinned: true }, "Pinned note content.");

    const { buildLearnPlan } = await import("../../learn.js");
    const plan = await buildLearnPlan({ kbRoot: kbRoot(), minNotes: 3 });
    const cluster = plan.clusters.find((c) => c.cluster === folder);
    assert.ok(cluster, "cluster should exist");
    assert.ok(
      !cluster!.sources.includes(`${folder}/pinned.md`),
      "pinned note should be excluded"
    );
    assert.equal(cluster!.sources.length, 4, "should have 4 non-pinned sources");
  });
});
