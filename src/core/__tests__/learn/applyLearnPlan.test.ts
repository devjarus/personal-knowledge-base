/**
 * applyLearnPlan.test.ts — Tests for applyLearnPlan() in src/core/learn.ts.
 *
 * Tests:
 *  1. New cluster: writes _summary.md, appends header + learning-write + commit.
 *  2. Fresh cluster: skipped (no write).
 *  3. Stale overwrite: previousContent captured; ledger records it.
 *  4. Conflict (user-edited summary): skip without force.
 *  5. Conflict with force: overwrite proceeds.
 *  6. Lock-held rejection: throws LearnError("LOCK_HELD"), no writes.
 *  7. Ledger structure: header → learning-write → commit records verified.
 *  8. previousContent is absent (null) for new file writes.
 *  9. previousContent is present (base64) for overwrites.
 * 10. Integration: apply → check _summary.md frontmatter has expected fields.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-apply-learn-test-"));
});

after(async () => {
  delete process.env.KB_ROOT;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const sub = await fs.mkdtemp(path.join(tmpDir, "run-"));
  process.env.KB_ROOT = sub;
  const { _invalidateNotesCache } = await import("../../fs.js");
  _invalidateNotesCache();
});

function root(): string {
  return process.env.KB_ROOT!;
}

async function writeNote(
  relPath: string,
  frontmatter: Record<string, unknown> = {},
  body = "Test body content with enough text."
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

/** Build a minimal LearnPlan with one cluster. */
async function buildSimplePlan(
  clusterPath: string,
  notes: string[],
  status: "new" | "stale" | "fresh"
) {
  const { hashSources } = await import("../../learn/sourceHashes.js");
  const sourceHashes = status === "fresh" ? await hashSources(root(), notes) : await hashSources(root(), notes);
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
    stats: { total: 1, new: status === "new" ? 1 : 0, stale: status === "stale" ? 1 : 0, fresh: status === "fresh" ? 1 : 0, skipped: 0 },
  };
}

describe("applyLearnPlan", () => {
  test("new cluster: writes _summary.md and creates ledger", async () => {
    const { applyLearnPlan } = await import("../../learn.js");

    // Create 3 notes.
    await writeNote("ideas/ml/note1.md", { title: "Neural Networks", tags: ["ml", "ai"] });
    await writeNote("ideas/ml/note2.md", { title: "Backprop", tags: ["ml"] });
    await writeNote("ideas/ml/note3.md", { title: "Gradient Descent", tags: ["optimization"] });

    const plan = await buildSimplePlan("ideas/ml", ["ideas/ml/note1.md", "ideas/ml/note2.md", "ideas/ml/note3.md"], "new");
    const result = await applyLearnPlan(plan);

    // Summary written.
    assert.equal(result.applied.length, 1);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.applied[0].cluster, "ideas/ml");
    assert.equal(result.applied[0].overwrote, false);

    // File exists on disk.
    const summaryPath = path.join(root(), "ideas/ml/_summary.md");
    const content = await fs.readFile(summaryPath, "utf8");
    assert.ok(content.includes("type: cluster-summary"), "should have cluster-summary type");
    assert.ok(content.includes("## Themes"), "should have Themes section");
    assert.ok(content.includes("## Sources"), "should have Sources section");

    // Ledger file exists.
    assert.ok(result.ledgerPath.length > 0);
    const ledgerExists = await fs.access(result.ledgerPath).then(() => true).catch(() => false);
    assert.ok(ledgerExists, "ledger file should exist");
  });

  test("fresh cluster: skipped without writing", async () => {
    const { applyLearnPlan } = await import("../../learn.js");

    await writeNote("ideas/fresh/n1.md", { title: "A" });
    await writeNote("ideas/fresh/n2.md", { title: "B" });
    await writeNote("ideas/fresh/n3.md", { title: "C" });

    const plan = await buildSimplePlan(
      "ideas/fresh",
      ["ideas/fresh/n1.md", "ideas/fresh/n2.md", "ideas/fresh/n3.md"],
      "fresh"
    );
    const result = await applyLearnPlan(plan);

    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, "fresh");

    // No summary file written.
    const summaryPath = path.join(root(), "ideas/fresh/_summary.md");
    const exists = await fs.access(summaryPath).then(() => true).catch(() => false);
    assert.equal(exists, false);
  });

  test("stale overwrite: captures previousContent in ledger", async () => {
    const { applyLearnPlan, buildLearnPlan } = await import("../../learn.js");
    const { readLearnLedger } = await import("../../learn/ledger.js");

    await writeNote("ideas/stale/n1.md", { title: "Alpha", tags: ["x"] });
    await writeNote("ideas/stale/n2.md", { title: "Beta", tags: ["y"] });
    await writeNote("ideas/stale/n3.md", { title: "Gamma", tags: ["z"] });

    // First apply — creates the summary.
    const plan1 = await buildSimplePlan(
      "ideas/stale",
      ["ideas/stale/n1.md", "ideas/stale/n2.md", "ideas/stale/n3.md"],
      "new"
    );
    const result1 = await applyLearnPlan(plan1);
    assert.equal(result1.applied.length, 1);

    // Capture what was written.
    const firstContent = await fs.readFile(path.join(root(), "ideas/stale/_summary.md"), "utf8");

    // Wait 1ms to ensure a new ledger timestamp.
    await new Promise<void>((r) => setTimeout(() => r(), 1));

    // Second apply — status "stale" should overwrite and capture previousContent.
    const plan2 = await buildSimplePlan(
      "ideas/stale",
      ["ideas/stale/n1.md", "ideas/stale/n2.md", "ideas/stale/n3.md"],
      "stale"
    );
    const result2 = await applyLearnPlan(plan2, { force: true });

    assert.equal(result2.applied.length, 1);
    assert.equal(result2.applied[0].overwrote, true);

    // Check ledger record has previousContent.
    const ledgerRecords = await readLearnLedger(result2.ledgerPath);
    const writeRecord = ledgerRecords.find((r) => r.kind === "learning-write") as
      | import("../../learn/ledger.js").LearnLedgerWriteRecord
      | undefined;
    assert.ok(writeRecord, "should have a learning-write record");
    assert.ok(writeRecord.previousContent !== null, "previousContent should be set for overwrite");
    assert.ok(writeRecord.previousContentHash !== null, "previousContentHash should be set");

    // previousContent should decode to the first summary content.
    const decoded = Buffer.from(writeRecord.previousContent!, "base64").toString("utf8");
    assert.equal(decoded, firstContent);
  });

  test("previousContent is null for new file writes", async () => {
    const { applyLearnPlan } = await import("../../learn.js");
    const { readLearnLedger } = await import("../../learn/ledger.js");

    await writeNote("ideas/newfile/n1.md", { title: "X" });
    await writeNote("ideas/newfile/n2.md", { title: "Y" });
    await writeNote("ideas/newfile/n3.md", { title: "Z" });

    const plan = await buildSimplePlan(
      "ideas/newfile",
      ["ideas/newfile/n1.md", "ideas/newfile/n2.md", "ideas/newfile/n3.md"],
      "new"
    );
    const result = await applyLearnPlan(plan);

    const records = await readLearnLedger(result.ledgerPath);
    const writeRecord = records.find((r) => r.kind === "learning-write") as
      | import("../../learn/ledger.js").LearnLedgerWriteRecord
      | undefined;
    assert.ok(writeRecord);
    assert.equal(writeRecord.previousContent, null, "new file: previousContent should be null");
    assert.equal(writeRecord.previousContentHash, null, "new file: previousContentHash should be null");
  });

  test("conflict without force: skips user-edited summary", async () => {
    const { applyLearnPlan } = await import("../../learn.js");

    await writeNote("ideas/conflict/n1.md", { title: "P" });
    await writeNote("ideas/conflict/n2.md", { title: "Q" });
    await writeNote("ideas/conflict/n3.md", { title: "R" });

    // First apply — creates the summary.
    const plan1 = await buildSimplePlan(
      "ideas/conflict",
      ["ideas/conflict/n1.md", "ideas/conflict/n2.md", "ideas/conflict/n3.md"],
      "new"
    );
    await applyLearnPlan(plan1);

    // User edits the summary.
    const summaryPath = path.join(root(), "ideas/conflict/_summary.md");
    await fs.appendFile(summaryPath, "\n\n## User note\nI edited this.\n", "utf8");

    await new Promise<void>((r) => setTimeout(() => r(), 1));

    // Second apply — status "stale", NO force → should skip.
    const plan2 = await buildSimplePlan(
      "ideas/conflict",
      ["ideas/conflict/n1.md", "ideas/conflict/n2.md", "ideas/conflict/n3.md"],
      "stale"
    );
    const result2 = await applyLearnPlan(plan2);

    assert.equal(result2.applied.length, 0, "should not apply when user edited");
    assert.equal(result2.skipped.length, 1);
    assert.ok(
      result2.skipped[0].reason.includes("user edited"),
      `Expected 'user edited' in reason, got: ${result2.skipped[0].reason}`
    );
  });

  test("conflict with force: overwrites user-edited summary", async () => {
    const { applyLearnPlan } = await import("../../learn.js");

    await writeNote("ideas/forceconflict/n1.md", { title: "A" });
    await writeNote("ideas/forceconflict/n2.md", { title: "B" });
    await writeNote("ideas/forceconflict/n3.md", { title: "C" });

    // First apply.
    const plan1 = await buildSimplePlan(
      "ideas/forceconflict",
      ["ideas/forceconflict/n1.md", "ideas/forceconflict/n2.md", "ideas/forceconflict/n3.md"],
      "new"
    );
    await applyLearnPlan(plan1);

    // User edits.
    const summaryPath = path.join(root(), "ideas/forceconflict/_summary.md");
    await fs.appendFile(summaryPath, "\n<!-- user edit -->\n", "utf8");

    await new Promise<void>((r) => setTimeout(() => r(), 1));

    // Second apply with force.
    const plan2 = await buildSimplePlan(
      "ideas/forceconflict",
      ["ideas/forceconflict/n1.md", "ideas/forceconflict/n2.md", "ideas/forceconflict/n3.md"],
      "stale"
    );
    const result2 = await applyLearnPlan(plan2, { force: true });

    assert.equal(result2.applied.length, 1, "force should overwrite");
  });

  test("lock-held rejection: throws LearnError(LOCK_HELD)", async () => {
    const { applyLearnPlan, LearnError } = await import("../../learn.js");
    const { learnLockPath } = await import("../../learn/ledger.js");

    await writeNote("ideas/lock/n1.md", { title: "L1" });
    await writeNote("ideas/lock/n2.md", { title: "L2" });
    await writeNote("ideas/lock/n3.md", { title: "L3" });

    const lp = learnLockPath(root());
    await fs.mkdir(path.dirname(lp), { recursive: true });
    // Write our own PID — we are alive, so the lock appears held.
    await fs.writeFile(lp, String(process.pid), "utf8");

    const plan = await buildSimplePlan(
      "ideas/lock",
      ["ideas/lock/n1.md", "ideas/lock/n2.md", "ideas/lock/n3.md"],
      "new"
    );

    try {
      await assert.rejects(
        () => applyLearnPlan(plan),
        (err: unknown) => {
          assert.ok(err instanceof LearnError);
          assert.equal(err.code, "LOCK_HELD");
          return true;
        }
      );

      // Verify no summary was written.
      const summaryPath = path.join(root(), "ideas/lock/_summary.md");
      const exists = await fs.access(summaryPath).then(() => true).catch(() => false);
      assert.equal(exists, false, "no summary should be written when lock is held");
    } finally {
      await fs.rm(lp, { force: true });
    }
  });

  test("ledger structure: header, learning-write, commit records in order", async () => {
    const { applyLearnPlan } = await import("../../learn.js");
    const { readLearnLedger } = await import("../../learn/ledger.js");

    await writeNote("ideas/ledger/n1.md", { title: "T1", tags: ["tag1"] });
    await writeNote("ideas/ledger/n2.md", { title: "T2", tags: ["tag2"] });
    await writeNote("ideas/ledger/n3.md", { title: "T3", tags: ["tag3"] });

    const plan = await buildSimplePlan(
      "ideas/ledger",
      ["ideas/ledger/n1.md", "ideas/ledger/n2.md", "ideas/ledger/n3.md"],
      "new"
    );
    const result = await applyLearnPlan(plan);

    const records = await readLearnLedger(result.ledgerPath);
    assert.ok(records.length >= 3, `Expected at least 3 records, got ${records.length}`);

    // First record = header.
    assert.equal(records[0].kind, "header");
    const header = records[0] as import("../../learn/ledger.js").LearnLedgerHeaderRecord;
    assert.ok(header.generatedAt.length > 0);
    assert.equal(header.generator, "kb-learn@0.1.0");

    // Middle record = learning-write.
    const writeRecord = records.find((r) => r.kind === "learning-write") as
      | import("../../learn/ledger.js").LearnLedgerWriteRecord
      | undefined;
    assert.ok(writeRecord, "should have a learning-write record");
    assert.ok(writeRecord.path.endsWith("/_summary.md"));
    assert.equal(writeRecord.contentHash.length, 64, "SHA-256 should be 64 hex chars");
    assert.ok(Array.isArray(writeRecord.sourceHashes));
    assert.equal(writeRecord.sourceHashes.length, 3);

    // Last record = commit.
    const lastRecord = records[records.length - 1];
    assert.equal(lastRecord.kind, "commit");
    const commit = lastRecord as import("../../learn/ledger.js").LearnLedgerCommitRecord;
    assert.equal(commit.written, 1);
  });

  test("integration: _summary.md frontmatter has required fields", async () => {
    const { applyLearnPlan } = await import("../../learn.js");

    await writeNote("ideas/fm/n1.md", { title: "Note One", tags: ["alpha"] }, "First note content here.");
    await writeNote("ideas/fm/n2.md", { title: "Note Two", tags: ["beta"] }, "Second note content here.");
    await writeNote("ideas/fm/n3.md", { title: "Note Three", tags: ["gamma"] }, "Third note content here.");

    const plan = await buildSimplePlan(
      "ideas/fm",
      ["ideas/fm/n1.md", "ideas/fm/n2.md", "ideas/fm/n3.md"],
      "new"
    );
    await applyLearnPlan(plan);

    const summaryContent = await fs.readFile(
      path.join(root(), "ideas/fm/_summary.md"),
      "utf8"
    );

    // Check all required frontmatter fields.
    assert.ok(summaryContent.includes("type: cluster-summary"), "type field");
    assert.ok(summaryContent.includes("generator: kb-learn@0.1.0"), "generator field");
    assert.ok(summaryContent.includes("cluster: ideas/fm"), "cluster field");
    assert.ok(summaryContent.includes("generatedAt:"), "generatedAt field");
    assert.ok(summaryContent.includes("sourceCount: 3"), "sourceCount field");
    assert.ok(summaryContent.includes("sourceHashes:"), "sourceHashes field");
    assert.ok(summaryContent.includes("organize: false"), "organize: false carve-out");
    assert.ok(summaryContent.includes("pinned: true"), "pinned: true");
    assert.ok(summaryContent.includes("## Sources"), "Sources section");
    assert.ok(summaryContent.includes("[[ideas/fm/n1.md]]"), "wiki-link source 1");
    assert.ok(summaryContent.includes("[[ideas/fm/n2.md]]"), "wiki-link source 2");
    assert.ok(summaryContent.includes("[[ideas/fm/n3.md]]"), "wiki-link source 3");
  });
});
