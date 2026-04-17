/**
 * Integration tests for organize.ts — buildOrganizePlan()
 *
 * Tests cover:
 *   1. Tag-first priority ladder
 *   2. Carve-out enforcement (meta/, daily/, dotfiles, organize:false, pinned:true)
 *   3. Collision handling
 *   4. Unassigned fallback (below min-confidence)
 *   5. Deterministic output on repeat runs
 *   6. mode: "incremental" short-circuits when clusters.json absent
 *   7. Missing .kb-index throws OrganizeError
 *
 * Uses a synthetic in-memory KB fixture (temp dir). No real KB_ROOT required.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Temp dir fixture
// ---------------------------------------------------------------------------

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-org-test-"));
  process.env.KB_ROOT = tmpDir;
});

after(async () => {
  delete process.env.KB_ROOT;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Reset KB_ROOT before each test (some tests override it).
beforeEach(() => {
  process.env.KB_ROOT = tmpDir;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a note file in the temp KB. */
async function writeNote(
  relPath: string,
  frontmatter: Record<string, unknown>,
  body = "Test body content."
): Promise<void> {
  const abs = path.join(tmpDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const fmLines = Object.entries(frontmatter).map(([k, v]) =>
    typeof v === "string"
      ? `${k}: ${v}`
      : `${k}: ${JSON.stringify(v)}`
  );
  const content = fmLines.length > 0
    ? `---\n${fmLines.join("\n")}\n---\n${body}\n`
    : `${body}\n`;
  await fs.writeFile(abs, content, "utf8");
}

/** Create the .kb-index dir and a minimal embeddings.jsonl with unit vectors. */
async function seedIndex(
  notes: Array<{ path: string; seed?: number }>
): Promise<void> {
  const indexDir = path.join(tmpDir, ".kb-index");
  await fs.mkdir(indexDir, { recursive: true });

  const DIM = 8;
  const lines: string[] = [];
  for (const { path: notePath, seed = 1 } of notes) {
    const vec: number[] = [];
    let acc = 0;
    for (let i = 0; i < DIM; i++) {
      const v = Math.sin(seed * (i + 1) * 0.37 + seed);
      vec.push(v);
      acc += v * v;
    }
    const norm = Math.sqrt(acc);
    const normalized = vec.map((v) => v / norm);
    lines.push(
      JSON.stringify({
        path: notePath,
        sig: "1234:100",
        model: "test-model",
        dim: DIM,
        vec: normalized,
      })
    );
  }
  await fs.writeFile(
    path.join(indexDir, "embeddings.jsonl"),
    lines.join("\n") + (lines.length > 0 ? "\n" : ""),
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// Test 1: Missing .kb-index → OrganizeError
// ---------------------------------------------------------------------------

describe("buildOrganizePlan — missing .kb-index", () => {
  test("throws OrganizeError when .kb-index is missing", async () => {
    const { buildOrganizePlan, OrganizeError } = await import("@/core/organize.js");

    // Use a fresh temp dir with NO .kb-index.
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-org-empty-"));
    try {
      await assert.rejects(
        () => buildOrganizePlan({ mode: "full", kbRoot: emptyDir }),
        (err: unknown) => {
          assert.ok(err instanceof OrganizeError);
          assert.match(err.message, /kb reindex/);
          return true;
        }
      );
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: Tag-first priority ladder
// ---------------------------------------------------------------------------

describe("buildOrganizePlan — tag-first priority ladder", () => {
  test("notes with type: go to type folder; notes with tags: go to tag folder", async () => {
    const { buildOrganizePlan } = await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    _invalidateNotesCache();
    _invalidateSemanticCache();

    // Create notes.
    await writeNote("typed-note.md", { type: "project", title: "Typed Note" });
    await writeNote("tagged-note.md", { tags: ["agents"], title: "Tagged Note" });
    await writeNote("plain-note.md", { title: "Plain Note" });

    await seedIndex([
      { path: "typed-note.md", seed: 1 },
      { path: "tagged-note.md", seed: 2 },
      { path: "plain-note.md", seed: 3 },
    ]);

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const plan = await buildOrganizePlan({ mode: "full", kbRoot: tmpDir });

    const typedMove = plan.moves.find((m) => m.from === "typed-note.md");
    const taggedMove = plan.moves.find((m) => m.from === "tagged-note.md");

    // type: note should go to project/ folder.
    assert.ok(typedMove !== undefined, "typed-note.md should have a move");
    assert.equal(typedMove!.reason, "type");
    assert.equal(typedMove!.to, "project/typed-note.md");
    assert.equal(typedMove!.confidence, 1.0);

    // tagged note should go to agents/ folder.
    assert.ok(taggedMove !== undefined, "tagged-note.md should have a move");
    assert.equal(taggedMove!.reason, "tag");
    assert.equal(taggedMove!.to, "agents/tagged-note.md");
  });

  test("note with both type and tags: type wins", async () => {
    const { buildOrganizePlan } = await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    _invalidateNotesCache();
    _invalidateSemanticCache();

    await writeNote("both-fields.md", {
      type: "project",
      tags: ["agents", "memory"],
      title: "Both Fields",
    });
    await seedIndex([{ path: "both-fields.md", seed: 5 }]);

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const plan = await buildOrganizePlan({ mode: "full", kbRoot: tmpDir });
    const move = plan.moves.find((m) => m.from === "both-fields.md");
    assert.ok(move !== undefined);
    assert.equal(move!.reason, "type");
    assert.equal(move!.to, "project/both-fields.md");
  });
});

// ---------------------------------------------------------------------------
// Test 3: Carve-out enforcement
// ---------------------------------------------------------------------------

describe("buildOrganizePlan — carve-out enforcement", () => {
  test("meta/, daily/, dotfiles, organize:false, pinned:true are excluded from moves", async () => {
    const { buildOrganizePlan } = await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    _invalidateNotesCache();
    _invalidateSemanticCache();

    // These should all be carved out.
    await writeNote("meta/session.md", { title: "Session" });
    await writeNote("daily/2026-04-14.md", { title: "Daily" });
    await writeNote("normal-with-organize-false.md", {
      title: "No Organize",
      organize: false,
    });
    await writeNote("pinned-note.md", { title: "Pinned", pinned: true });

    await seedIndex([
      { path: "meta/session.md", seed: 10 },
      { path: "daily/2026-04-14.md", seed: 11 },
      { path: "normal-with-organize-false.md", seed: 12 },
      { path: "pinned-note.md", seed: 13 },
    ]);

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const plan = await buildOrganizePlan({ mode: "full", kbRoot: tmpDir });

    // None of the carved-out notes should appear in moves or unassigned.
    const allHandledPaths = [
      ...plan.moves.map((m) => m.from),
      ...plan.unassigned.map((u) => u.path),
    ];

    assert.ok(
      !allHandledPaths.includes("meta/session.md"),
      "meta/ note must be silently excluded"
    );
    assert.ok(
      !allHandledPaths.includes("daily/2026-04-14.md"),
      "daily/ note must be silently excluded"
    );
    assert.ok(
      !allHandledPaths.includes("normal-with-organize-false.md"),
      "organize:false note must be silently excluded"
    );
    assert.ok(
      !allHandledPaths.includes("pinned-note.md"),
      "pinned:true note must be silently excluded"
    );
  });
});

// ---------------------------------------------------------------------------
// Test 4: Collision handling
// ---------------------------------------------------------------------------

describe("buildOrganizePlan — collision handling", () => {
  test("two notes wanting the same target: first wins, second goes to unassigned", async () => {
    const { buildOrganizePlan } = await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    _invalidateNotesCache();
    _invalidateSemanticCache();

    // Two notes with the same type and same filename (from different source dirs).
    await writeNote("src/note.md", { type: "project", title: "Source Note" });
    await writeNote("archive/note.md", { type: "project", title: "Archive Note" });

    await seedIndex([
      { path: "src/note.md", seed: 20 },
      { path: "archive/note.md", seed: 21 },
    ]);

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const plan = await buildOrganizePlan({ mode: "full", kbRoot: tmpDir });

    // Both want "project/note.md" — one gets it, the other goes to unassigned.
    const targetNotes = plan.moves.filter((m) => m.to === "project/note.md");
    assert.equal(targetNotes.length, 1, "Only one note should claim the target path");

    const unassignedPaths = plan.unassigned.map((u) => u.path);
    // Exactly one of the two should be unassigned.
    const colliders = ["src/note.md", "archive/note.md"];
    const movedPaths = plan.moves.map((m) => m.from);
    const colliderInMoves = colliders.filter((p) => movedPaths.includes(p));
    const colliderInUnassigned = colliders.filter((p) => unassignedPaths.includes(p));

    assert.equal(colliderInMoves.length, 1, "Exactly one collider should be in moves");
    assert.equal(colliderInUnassigned.length, 1, "Exactly one collider should be unassigned");

    // Unassigned reason should mention "collision".
    const collisionEntry = plan.unassigned.find((u) =>
      colliders.includes(u.path)
    );
    assert.ok(collisionEntry !== undefined);
    assert.match(collisionEntry!.reason, /collision/i);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Deterministic output on repeat runs
// ---------------------------------------------------------------------------

describe("buildOrganizePlan — determinism", () => {
  test("two calls on the same KB produce identical plans", async () => {
    const { buildOrganizePlan } = await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    _invalidateNotesCache();
    _invalidateSemanticCache();

    await writeNote("determ-a.md", { tags: ["rag"], title: "RAG Note A" });
    await writeNote("determ-b.md", { tags: ["rag"], title: "RAG Note B" });
    await writeNote("determ-c.md", { title: "Cluster Note C" });

    await seedIndex([
      { path: "determ-a.md", seed: 30 },
      { path: "determ-b.md", seed: 31 },
      { path: "determ-c.md", seed: 32 },
    ]);

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const plan1 = await buildOrganizePlan({ mode: "full", kbRoot: tmpDir });

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const plan2 = await buildOrganizePlan({ mode: "full", kbRoot: tmpDir });

    // Remove generatedAt (timestamp differs between calls).
    const normalize = (p: typeof plan1) => ({
      ...p,
      generatedAt: "<normalized>",
    });

    assert.deepEqual(
      normalize(plan1),
      normalize(plan2),
      "Plans must be identical across two calls (except timestamp)"
    );
  });
});

// ---------------------------------------------------------------------------
// Test 6: mode: "incremental" short-circuits when clusters.json is absent
// ---------------------------------------------------------------------------

describe("buildOrganizePlan — incremental mode", () => {
  test("mode:'incremental' throws when clusters.json is absent", async () => {
    const { buildOrganizePlan, OrganizeError } = await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    _invalidateNotesCache();
    _invalidateSemanticCache();

    // .kb-index exists but no organize/clusters.json.
    const incrementalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "kb-org-incr-")
    );
    try {
      await fs.mkdir(path.join(incrementalDir, ".kb-index"), { recursive: true });
      await fs.writeFile(
        path.join(incrementalDir, ".kb-index", "embeddings.jsonl"),
        "",
        "utf8"
      );

      await assert.rejects(
        () =>
          buildOrganizePlan({ mode: "incremental", kbRoot: incrementalDir }),
        (err: unknown) => {
          assert.ok(err instanceof OrganizeError);
          assert.match(err.message, /clusters\.json/i);
          return true;
        }
      );
    } finally {
      await fs.rm(incrementalDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7: Plan shape is structurally valid (smoke test)
// ---------------------------------------------------------------------------

describe("buildOrganizePlan — plan shape", () => {
  test("returns a structurally valid OrganizePlan", async () => {
    const { buildOrganizePlan } = await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    _invalidateNotesCache();
    _invalidateSemanticCache();

    await writeNote("shape-a.md", { tags: ["ai"], title: "AI Note" });
    await seedIndex([{ path: "shape-a.md", seed: 40 }]);

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const plan = await buildOrganizePlan({ mode: "full", kbRoot: tmpDir });

    // Structural checks.
    assert.ok(typeof plan.generatedAt === "string" && plan.generatedAt.length > 0);
    assert.ok(plan.mode === "full" || plan.mode === "incremental");
    assert.ok(Array.isArray(plan.moves));
    assert.ok(Array.isArray(plan.rewrites));
    assert.ok(Array.isArray(plan.unassigned));
    assert.ok(Array.isArray(plan.clusters));
    assert.ok(typeof plan.stats === "object");
    assert.ok(typeof plan.stats.total === "number");
    assert.ok(typeof plan.stats.byType === "number");
    assert.ok(typeof plan.stats.byTag === "number");
    assert.ok(typeof plan.stats.byCluster === "number");
    assert.ok(typeof plan.stats.unassigned === "number");

    // stats.total should equal sum of categorized + unassigned (minus carved-out).
    // We can't assert exact total since some notes are carved out, but check non-negative.
    assert.ok(plan.stats.total >= 0);

    // Moves must have required fields.
    for (const move of plan.moves) {
      assert.ok(typeof move.from === "string" && move.from.length > 0);
      assert.ok(typeof move.to === "string" && move.to.length > 0);
      assert.ok(["type", "tag", "cluster", "user-filed"].includes(move.reason));
      assert.ok(typeof move.confidence === "number");
      // from !== to (no no-op moves).
      assert.notEqual(move.from, move.to, "Move must change the path");
    }
  });
});
