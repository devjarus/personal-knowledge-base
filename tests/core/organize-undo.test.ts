/**
 * organize-undo.test.ts — TDD tests for undoLastOrganize (Phase 2).
 *
 * Tests:
 *  1. undo round-trips byte-identically to the pre-apply state.
 *  2. apply → user edits a moved note → undo reports that note in conflicts.
 *  3. The rest undo cleanly when one note conflicts.
 *  4. undoLastOrganize with no ledger throws NO_LEDGER.
 *  5. undoLastOrganize renames the ledger to .undone.jsonl after success.
 *  6. undoLastOrganize won't undo an already-undone ledger (it's renamed).
 *  7. Sidecar entries are renamed back on undo.
 */

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Fixture helpers (same pattern as organize-apply.test.ts)
// ---------------------------------------------------------------------------

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-undo-test-"));
});

after(async () => {
  delete process.env.KB_ROOT;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const sub = await fs.mkdtemp(path.join(tmpDir, "run-"));
  process.env.KB_ROOT = sub;
  const { _invalidateNotesCache } = await import("@/core/fs.js");
  const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");
  _invalidateNotesCache();
  _invalidateSemanticCache();
});

afterEach(async () => {
  const { _invalidateNotesCache } = await import("@/core/fs.js");
  const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");
  _invalidateNotesCache();
  _invalidateSemanticCache();
});

/** Create a note file in the current KB_ROOT. */
async function writeNote(
  relPath: string,
  frontmatter: Record<string, unknown> = {},
  body = "Test body content."
): Promise<void> {
  const root = process.env.KB_ROOT!;
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const fmLines = Object.entries(frontmatter).map(([k, v]) =>
    typeof v === "string" ? `${k}: ${v}` : `${k}: ${JSON.stringify(v)}`
  );
  const content =
    fmLines.length > 0
      ? `---\n${fmLines.join("\n")}\n---\n${body}\n`
      : `${body}\n`;
  await fs.writeFile(abs, content, "utf8");
}

/** Create .kb-index + embeddings.jsonl with synthetic unit vectors. */
async function seedIndex(
  notes: Array<{ path: string; seed?: number }>
): Promise<void> {
  const root = process.env.KB_ROOT!;
  const indexDir = path.join(root, ".kb-index");
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

/** Recursively collect all file paths relative to root. */
async function collectFiles(root: string, base = root): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // Skip sidecar and lock files.
    if (e.name.startsWith(".kb-index")) continue;
    const abs = path.join(root, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectFiles(abs, base)));
    } else {
      out.push(path.relative(base, abs));
    }
  }
  return out.sort();
}

/** Map relPath → file content for all .md files. */
async function snapshotNotes(root: string): Promise<Map<string, string>> {
  const files = await collectFiles(root);
  const map = new Map<string, string>();
  for (const rel of files) {
    if (!rel.endsWith(".md")) continue;
    const abs = path.join(root, rel);
    const content = await fs.readFile(abs, "utf8");
    map.set(rel, content);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Test 1: undo round-trips byte-identically.
// ---------------------------------------------------------------------------

describe("undoLastOrganize — round-trip", () => {
  test("undo restores the pre-apply file tree byte-identically", async () => {
    const { buildOrganizePlan, applyOrganizePlan, undoLastOrganize } =
      await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    const root = process.env.KB_ROOT!;

    const body1 = "Agents note body — unique content A9F3.";
    const body2 = "RAG note body — unique content B7E2.";
    await writeNote("agents-roundtrip.md", { tags: ["agents"], title: "Agents RT" }, body1);
    await writeNote("rag-roundtrip.md", { tags: ["rag"], title: "RAG RT" }, body2);
    await seedIndex([
      { path: "agents-roundtrip.md", seed: 1 },
      { path: "rag-roundtrip.md", seed: 2 },
    ]);

    _invalidateNotesCache();
    _invalidateSemanticCache();

    // Snapshot before apply.
    const snapshotBefore = await snapshotNotes(root);

    const plan = await buildOrganizePlan({ mode: "full", kbRoot: root });
    assert.ok(plan.moves.length > 0, "must have moves to test undo");

    _invalidateNotesCache();
    _invalidateSemanticCache();

    await applyOrganizePlan(plan, {});

    _invalidateNotesCache();
    _invalidateSemanticCache();

    // Verify files moved.
    const snapshotAfterApply = await snapshotNotes(root);
    assert.notDeepEqual(
      [...snapshotBefore.keys()].sort(),
      [...snapshotAfterApply.keys()].sort(),
      "file list should differ after apply"
    );

    // Undo.
    await undoLastOrganize();

    _invalidateNotesCache();
    _invalidateSemanticCache();

    // Snapshot after undo — should match pre-apply snapshot.
    const snapshotAfterUndo = await snapshotNotes(root);

    assert.deepEqual(
      [...snapshotAfterUndo.keys()].sort(),
      [...snapshotBefore.keys()].sort(),
      "file list should match pre-apply state after undo"
    );

    for (const [relPath, originalContent] of snapshotBefore) {
      const restoredContent = snapshotAfterUndo.get(relPath);
      assert.equal(
        restoredContent,
        originalContent,
        `Content of ${relPath} must be byte-identical after undo`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: User-edited note after apply → conflict in undo.
// ---------------------------------------------------------------------------

describe("undoLastOrganize — conflict detection", () => {
  test("user-edited note after apply is reported as conflict and preserved", async () => {
    const { buildOrganizePlan, applyOrganizePlan, undoLastOrganize } =
      await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    const root = process.env.KB_ROOT!;

    await writeNote("agents-edited.md", { tags: ["agents"], title: "Agents Edited" });
    await writeNote("rag-unchanged.md", { tags: ["rag"], title: "RAG Unchanged" });
    await seedIndex([
      { path: "agents-edited.md", seed: 5 },
      { path: "rag-unchanged.md", seed: 6 },
    ]);

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const plan = await buildOrganizePlan({ mode: "full", kbRoot: root });
    const agentsMove = plan.moves.find((m) => m.from === "agents-edited.md");
    assert.ok(agentsMove, "agents-edited.md should have a planned move");

    _invalidateNotesCache();
    _invalidateSemanticCache();

    await applyOrganizePlan(plan, {});

    // User edits the moved file at its new location.
    const movedAbs = path.join(root, agentsMove!.to);
    await fs.writeFile(
      movedAbs,
      "---\ntags: [\"agents\"]\ntitle: Agents Edited\n---\nUser modified this post-organize!\n",
      "utf8"
    );

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const undoResult = await undoLastOrganize();

    // The edited note should appear in conflicts.
    const conflict = undoResult.conflicts.find((c) => c.path === agentsMove!.to);
    assert.ok(conflict, "edited note should appear in conflicts");

    // The edited note should remain at its moved location (preserved).
    const editedStillAtTarget = await fs.access(movedAbs).then(() => true).catch(() => false);
    assert.ok(editedStillAtTarget, "edited note should remain at moved location");

    // The RAG note should have been undone cleanly.
    const ragMove = plan.moves.find((m) => m.from === "rag-unchanged.md");
    if (ragMove) {
      const ragOriginal = path.join(root, "rag-unchanged.md");
      const ragRestored = await fs.access(ragOriginal).then(() => true).catch(() => false);
      assert.ok(ragRestored, "unedited note should be restored to original path");
    }
  });

  test("reverted count reflects only successfully undone moves", async () => {
    const { buildOrganizePlan, applyOrganizePlan, undoLastOrganize } =
      await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    const root = process.env.KB_ROOT!;

    await writeNote("agents-conflict.md", { tags: ["agents"], title: "Agents Conflict" });
    await writeNote("rag-clean.md", { tags: ["rag"], title: "RAG Clean" });
    await seedIndex([
      { path: "agents-conflict.md", seed: 7 },
      { path: "rag-clean.md", seed: 8 },
    ]);

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const plan = await buildOrganizePlan({ mode: "full", kbRoot: root });
    const totalMoves = plan.moves.length;

    _invalidateNotesCache();
    _invalidateSemanticCache();

    await applyOrganizePlan(plan, {});

    // Edit the first moved file to create a conflict.
    if (plan.moves.length > 0) {
      const firstMove = plan.moves[0];
      const targetAbs = path.join(root, firstMove.to);
      await fs.appendFile(targetAbs, "\nEdited post-organize.");
    }

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const undoResult = await undoLastOrganize();

    // reverted + conflicts = total moves.
    assert.equal(
      undoResult.reverted + undoResult.conflicts.length,
      totalMoves,
      "reverted + conflicts must equal total planned moves"
    );
  });
});

// ---------------------------------------------------------------------------
// Test 4: No ledger → throws NO_LEDGER.
// ---------------------------------------------------------------------------

describe("undoLastOrganize — no ledger", () => {
  test("throws NO_LEDGER when no ledger exists", async () => {
    const { undoLastOrganize, OrganizeError } = await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    const root = process.env.KB_ROOT!;
    await fs.mkdir(path.join(root, ".kb-index"), { recursive: true });
    await fs.writeFile(path.join(root, ".kb-index", "embeddings.jsonl"), "", "utf8");

    _invalidateNotesCache();
    _invalidateSemanticCache();

    await assert.rejects(
      () => undoLastOrganize(),
      (err: unknown) => {
        assert.ok(err instanceof OrganizeError, "should throw OrganizeError");
        assert.equal(err.code, "NO_LEDGER");
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Test 5: Ledger renamed to .undone.jsonl after undo.
// ---------------------------------------------------------------------------

describe("undoLastOrganize — ledger renamed", () => {
  test("ledger is renamed to .undone.jsonl after successful undo", async () => {
    const { buildOrganizePlan, applyOrganizePlan, undoLastOrganize } =
      await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    const root = process.env.KB_ROOT!;

    await writeNote("agents-rename-test.md", { tags: ["agents"], title: "Agents Rename" });
    await seedIndex([{ path: "agents-rename-test.md", seed: 15 }]);

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const plan = await buildOrganizePlan({ mode: "full", kbRoot: root });

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const applyResult = await applyOrganizePlan(plan, {});
    const originalLedgerPath = applyResult.ledgerPath;

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const undoResult = await undoLastOrganize();

    // Ledger should now be renamed to .undone.jsonl.
    assert.ok(undoResult.ledgerPath.endsWith(".undone.jsonl"), "undo result ledger should end in .undone.jsonl");
    assert.equal(
      undoResult.ledgerPath,
      originalLedgerPath.replace(/\.jsonl$/, ".undone.jsonl"),
      "undone ledger path should be original + .undone"
    );

    // Original ledger should no longer exist.
    const originalExists = await fs.access(originalLedgerPath).then(() => true).catch(() => false);
    assert.ok(!originalExists, "original ledger should be renamed (not at original path)");

    // Undone ledger should exist.
    const undoneExists = await fs.access(undoResult.ledgerPath).then(() => true).catch(() => false);
    assert.ok(undoneExists, "undone ledger should exist at new path");
  });
});

// ---------------------------------------------------------------------------
// Test 6: Already-undone ledger is not re-undone.
// ---------------------------------------------------------------------------

describe("undoLastOrganize — no double-undo", () => {
  test("after undo, findLatestLedger returns null (nothing left to undo)", async () => {
    const { buildOrganizePlan, applyOrganizePlan, undoLastOrganize, OrganizeError } =
      await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    const root = process.env.KB_ROOT!;

    await writeNote("agents-double.md", { tags: ["agents"], title: "Agents Double" });
    await seedIndex([{ path: "agents-double.md", seed: 20 }]);

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const plan = await buildOrganizePlan({ mode: "full", kbRoot: root });

    _invalidateNotesCache();
    _invalidateSemanticCache();

    await applyOrganizePlan(plan, {});

    _invalidateNotesCache();
    _invalidateSemanticCache();

    await undoLastOrganize();

    _invalidateNotesCache();
    _invalidateSemanticCache();

    // Second undo should throw NO_LEDGER because the only ledger is now .undone.jsonl.
    await assert.rejects(
      () => undoLastOrganize(),
      (err: unknown) => {
        assert.ok(err instanceof OrganizeError);
        assert.equal(err.code, "NO_LEDGER");
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Test 7: Sidecar entries are renamed back on undo.
// ---------------------------------------------------------------------------

describe("undoLastOrganize — sidecar reversal", () => {
  test("sidecar has original path key restored after undo", async () => {
    const { buildOrganizePlan, applyOrganizePlan, undoLastOrganize } =
      await import("@/core/organize.js");
    const { _invalidateNotesCache } = await import("@/core/fs.js");
    const { _invalidateSemanticCache } = await import("@/core/semanticIndex.js");

    const root = process.env.KB_ROOT!;

    await writeNote("agents-sidecar-undo.md", { tags: ["agents"], title: "Agents Sidecar Undo" });
    await seedIndex([{ path: "agents-sidecar-undo.md", seed: 25 }]);

    _invalidateNotesCache();
    _invalidateSemanticCache();

    const plan = await buildOrganizePlan({ mode: "full", kbRoot: root });
    const agentsMove = plan.moves.find((m) => m.from === "agents-sidecar-undo.md");
    assert.ok(agentsMove, "note should have a planned move");

    _invalidateNotesCache();
    _invalidateSemanticCache();

    await applyOrganizePlan(plan, {});

    // Verify new path is in sidecar.
    const sidecarPathApply = path.join(root, ".kb-index", "embeddings.jsonl");
    const sidecarAfterApply = await fs.readFile(sidecarPathApply, "utf8");
    const pathsAfterApply = sidecarAfterApply
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return (JSON.parse(l) as { path: string }).path; } catch { return null; } })
      .filter(Boolean) as string[];

    assert.ok(pathsAfterApply.includes(agentsMove!.to), "new path should be in sidecar after apply");

    _invalidateNotesCache();
    _invalidateSemanticCache();

    await undoLastOrganize();

    // Verify original path is restored in sidecar.
    const sidecarAfterUndo = await fs.readFile(sidecarPathApply, "utf8");
    const pathsAfterUndo = sidecarAfterUndo
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return (JSON.parse(l) as { path: string }).path; } catch { return null; } })
      .filter(Boolean) as string[];

    assert.ok(
      pathsAfterUndo.includes("agents-sidecar-undo.md"),
      "original path should be restored in sidecar after undo"
    );
    assert.ok(
      !pathsAfterUndo.includes(agentsMove!.to),
      "moved path should be gone from sidecar after undo"
    );
  });
});
