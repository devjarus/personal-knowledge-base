/**
 * undoLastLearn.test.ts — Tests for undoLastLearn() in src/core/learn.ts.
 *
 * Tests:
 *  1. NO_LEDGER: throws when no ledger exists.
 *  2. LOCK_HELD: throws when learn lock is held.
 *  3. New-file undo: summary created by apply is moved to trash.
 *  4. Overwrite undo: previousContent restored byte-for-byte.
 *  5. User-edited conflict: if summary changed after apply, left in place + reported.
 *  6. Partial-ledger tolerance: if file is missing, skip gracefully (no throw).
 *  7. Ledger renamed to .undone.jsonl after success.
 *  8. Already-undone ledger: cannot undo again (NO_LEDGER).
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-undo-learn-test-"));
});

after(async () => {
  delete process.env.KB_ROOT;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const sub = await fs.mkdtemp(path.join(tmpDir, "run-"));
  process.env.KB_ROOT = sub;
  const { _invalidateNotesCache } = await import("@/core/fs.js");
  _invalidateNotesCache();
});

function root(): string {
  return process.env.KB_ROOT!;
}

async function writeNote(
  relPath: string,
  frontmatter: Record<string, unknown> = {},
  body = "Test body content for testing."
): Promise<void> {
  const abs = path.join(root(), relPath);
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

async function buildSimplePlan(clusterPath: string, notes: string[], status: "new" | "stale" | "fresh") {
  const { hashSources } = await import("@/core/learn/sourceHashes.js");
  const sourceHashes = await hashSources(root(), notes);
  return {
    generatedAt: new Date().toISOString(),
    mode: "full" as const,
    generator: "extractive" as const,
    clusters: [
      {
        cluster: clusterPath,
        sources: notes,
        sourceHashes,
        summaryPath: `${clusterPath}/_summary.md`,
        generator: "extractive" as const,
        status,
      },
    ],
    stats: { total: 1, new: 1, stale: 0, fresh: 0, skipped: 0 },
  };
}

describe("undoLastLearn", () => {
  test("throws NO_LEDGER when no ledger exists", async () => {
    const { undoLastLearn, LearnError } = await import("@/core/learn.js");

    await assert.rejects(
      () => undoLastLearn(),
      (err: unknown) => {
        assert.ok(err instanceof LearnError);
        assert.equal(err.code, "NO_LEDGER");
        return true;
      }
    );
  });

  test("throws LOCK_HELD when learn lock is held", async () => {
    const { applyLearnPlan, undoLastLearn, LearnError } = await import("@/core/learn.js");
    const { learnLockPath } = await import("@/core/learn/ledger.js");

    // Create a cluster and apply to generate a ledger.
    await writeNote("ideas/lockundo/n1.md", { title: "L1" });
    await writeNote("ideas/lockundo/n2.md", { title: "L2" });
    await writeNote("ideas/lockundo/n3.md", { title: "L3" });

    const plan = await buildSimplePlan(
      "ideas/lockundo",
      ["ideas/lockundo/n1.md", "ideas/lockundo/n2.md", "ideas/lockundo/n3.md"],
      "new"
    );
    await applyLearnPlan(plan);

    // Now hold the lock ourselves.
    const lp = learnLockPath(root());
    await fs.writeFile(lp, String(process.pid), "utf8");

    try {
      await assert.rejects(
        () => undoLastLearn(),
        (err: unknown) => {
          assert.ok(err instanceof LearnError);
          assert.equal(err.code, "LOCK_HELD");
          return true;
        }
      );
    } finally {
      await fs.rm(lp, { force: true });
    }
  });

  test("new-file undo: summary moved to trash", async () => {
    const { applyLearnPlan, undoLastLearn } = await import("@/core/learn.js");

    await writeNote("ideas/newundo/n1.md", { title: "N1", tags: ["t"] });
    await writeNote("ideas/newundo/n2.md", { title: "N2", tags: ["t"] });
    await writeNote("ideas/newundo/n3.md", { title: "N3", tags: ["t"] });

    const plan = await buildSimplePlan(
      "ideas/newundo",
      ["ideas/newundo/n1.md", "ideas/newundo/n2.md", "ideas/newundo/n3.md"],
      "new"
    );
    await applyLearnPlan(plan);

    // Summary should exist.
    const summaryPath = path.join(root(), "ideas/newundo/_summary.md");
    const existsBefore = await fs.access(summaryPath).then(() => true).catch(() => false);
    assert.ok(existsBefore, "summary should exist before undo");

    const undoResult = await undoLastLearn();

    assert.equal(undoResult.restored, 1);
    assert.equal(undoResult.conflicts.length, 0);

    // Summary should no longer exist at original path.
    const existsAfter = await fs.access(summaryPath).then(() => true).catch(() => false);
    assert.equal(existsAfter, false, "summary should be gone after undo (moved to trash)");

    // Should be in .trash somewhere.
    const trashDir = path.join(root(), ".trash");
    const trashExists = await fs.access(trashDir).then(() => true).catch(() => false);
    assert.ok(trashExists, "trash dir should exist");
  });

  test("overwrite undo: previousContent restored byte-for-byte", async () => {
    const { applyLearnPlan, undoLastLearn } = await import("@/core/learn.js");

    await writeNote("ideas/prevundo/n1.md", { title: "P1", tags: ["x"] });
    await writeNote("ideas/prevundo/n2.md", { title: "P2", tags: ["y"] });
    await writeNote("ideas/prevundo/n3.md", { title: "P3", tags: ["z"] });

    const notes = ["ideas/prevundo/n1.md", "ideas/prevundo/n2.md", "ideas/prevundo/n3.md"];

    // First apply — creates the summary.
    const plan1 = await buildSimplePlan("ideas/prevundo", notes, "new");
    await applyLearnPlan(plan1);

    const summaryPath = path.join(root(), "ideas/prevundo/_summary.md");
    const firstContent = await fs.readFile(summaryPath);

    await new Promise<void>((r) => setTimeout(() => r(), 2));

    // Second apply with force — overwrites (captures previousContent in ledger).
    const plan2 = await buildSimplePlan("ideas/prevundo", notes, "stale");
    await applyLearnPlan(plan2, { force: true });

    // Capture second content.
    const secondContent = await fs.readFile(summaryPath);
    // Both generations are extractive so might be byte-identical; the test
    // still exercises the path. What matters is that undo uses previousContent.

    await new Promise<void>((r) => setTimeout(() => r(), 2));

    // Undo — should restore first content.
    const undoResult = await undoLastLearn();
    assert.equal(undoResult.restored, 1);
    assert.equal(undoResult.conflicts.length, 0);

    const restoredContent = await fs.readFile(summaryPath);
    assert.deepEqual(
      restoredContent,
      firstContent,
      "restored content should match the original (previousContent from ledger)"
    );

    // Suppress unused variable warning for secondContent.
    void secondContent;
  });

  test("user-edited conflict: left in place and reported", async () => {
    const { applyLearnPlan, undoLastLearn } = await import("@/core/learn.js");

    await writeNote("ideas/editundo/n1.md", { title: "E1" });
    await writeNote("ideas/editundo/n2.md", { title: "E2" });
    await writeNote("ideas/editundo/n3.md", { title: "E3" });

    const notes = ["ideas/editundo/n1.md", "ideas/editundo/n2.md", "ideas/editundo/n3.md"];
    const plan = await buildSimplePlan("ideas/editundo", notes, "new");
    await applyLearnPlan(plan);

    const summaryPath = path.join(root(), "ideas/editundo/_summary.md");

    // User edits the summary after apply.
    await fs.appendFile(summaryPath, "\n<!-- user edit -->\n", "utf8");
    const editedContent = await fs.readFile(summaryPath);

    // Undo — should detect the edit and report as conflict.
    const undoResult = await undoLastLearn();

    assert.equal(undoResult.restored, 0, "edited file should not be restored");
    assert.equal(undoResult.conflicts.length, 1);
    assert.ok(
      undoResult.conflicts[0].reason.includes("modified"),
      `Expected 'modified' in reason: ${undoResult.conflicts[0].reason}`
    );

    // File should still be in place (untouched by undo).
    const remainingContent = await fs.readFile(summaryPath);
    assert.deepEqual(remainingContent, editedContent, "edited file should remain unchanged");
  });

  test("partial-ledger tolerance: missing file is skipped gracefully", async () => {
    const { applyLearnPlan, undoLastLearn } = await import("@/core/learn.js");
    const { appendLearnRecord } = await import("@/core/learn/ledger.js");

    await writeNote("ideas/partial/n1.md", { title: "P" });
    await writeNote("ideas/partial/n2.md", { title: "Q" });
    await writeNote("ideas/partial/n3.md", { title: "R" });

    const notes = ["ideas/partial/n1.md", "ideas/partial/n2.md", "ideas/partial/n3.md"];
    const plan = await buildSimplePlan("ideas/partial", notes, "new");
    const result = await applyLearnPlan(plan);

    // Inject a phantom ledger record for a file that doesn't exist (crash simulation).
    await appendLearnRecord(result.ledgerPath, {
      kind: "learning-write",
      path: "ideas/partial/phantom/_summary.md",
      contentHash: "deadbeef".repeat(8),
      generator: "extractive",
      model: null,
      sourceHashes: [],
      previousContentHash: null,
      previousContent: null,
    });

    // Undo should tolerate the missing phantom file (skip, no throw).
    await assert.doesNotReject(
      () => undoLastLearn(),
      "undoLastLearn should tolerate orphan ledger records"
    );
  });

  test("ledger renamed to .undone.jsonl after success", async () => {
    const { applyLearnPlan, undoLastLearn } = await import("@/core/learn.js");

    await writeNote("ideas/renamed/n1.md", { title: "R1" });
    await writeNote("ideas/renamed/n2.md", { title: "R2" });
    await writeNote("ideas/renamed/n3.md", { title: "R3" });

    const notes = ["ideas/renamed/n1.md", "ideas/renamed/n2.md", "ideas/renamed/n3.md"];
    const plan = await buildSimplePlan("ideas/renamed", notes, "new");
    const applyResult = await applyLearnPlan(plan);

    const originalLedger = applyResult.ledgerPath;
    const undoResult = await undoLastLearn();

    // Original ledger should no longer exist.
    const origExists = await fs.access(originalLedger).then(() => true).catch(() => false);
    assert.equal(origExists, false, "original ledger should be renamed");

    // Undone ledger path should end with .undone.jsonl.
    assert.ok(
      undoResult.ledgerPath.endsWith(".undone.jsonl"),
      `Expected .undone.jsonl, got: ${undoResult.ledgerPath}`
    );

    const undoneExists = await fs.access(undoResult.ledgerPath).then(() => true).catch(() => false);
    assert.ok(undoneExists, "undone ledger should exist at the new path");
  });

  test("already-undone ledger: cannot undo again (NO_LEDGER)", async () => {
    const { applyLearnPlan, undoLastLearn, LearnError } = await import("@/core/learn.js");

    await writeNote("ideas/twice/n1.md", { title: "T1" });
    await writeNote("ideas/twice/n2.md", { title: "T2" });
    await writeNote("ideas/twice/n3.md", { title: "T3" });

    const notes = ["ideas/twice/n1.md", "ideas/twice/n2.md", "ideas/twice/n3.md"];
    const plan = await buildSimplePlan("ideas/twice", notes, "new");
    await applyLearnPlan(plan);

    // First undo succeeds.
    await undoLastLearn();

    // Second undo should fail with NO_LEDGER.
    await assert.rejects(
      () => undoLastLearn(),
      (err: unknown) => {
        assert.ok(err instanceof LearnError);
        assert.equal(err.code, "NO_LEDGER");
        return true;
      }
    );
  });
});
