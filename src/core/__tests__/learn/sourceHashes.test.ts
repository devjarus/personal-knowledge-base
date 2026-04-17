/**
 * sourceHashes.test.ts — Dedicated unit tests for src/core/learn/sourceHashes.ts.
 *
 * F4 fix: separate file rather than folded into buildLearnPlan.test.ts.
 *
 * Tests:
 *  1. hashSources: sorted output is stable regardless of input order.
 *  2. hashSources: different content → different hashes.
 *  3. hashSources: same content → same hashes (deterministic).
 *  4. readExistingSummary: returns null for absent _summary.md.
 *  5. readExistingSummary: returns null for a file without type: cluster-summary.
 *  6. readExistingSummary: parses sourceHashes, generator, model, contentHash.
 *  7. F2: model returns null (not "") for summaries missing the model field.
 *  8. readExistingSummary: tolerates missing sourceHashes field (returns []).
 *  9. hashBytes: produces correct SHA-256 of a buffer.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-sourcehashes-test-"));
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

async function writeFile(relPath: string, content: string): Promise<void> {
  const abs = path.join(root(), relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

describe("hashSources", () => {
  test("sorted output is stable regardless of input order", async () => {
    const { hashSources } = await import("../../learn/sourceHashes.js");

    await writeFile("a/n1.md", "content A");
    await writeFile("a/n2.md", "content B");
    await writeFile("a/n3.md", "content C");

    const hashes1 = await hashSources(root(), ["a/n1.md", "a/n2.md", "a/n3.md"]);
    const hashes2 = await hashSources(root(), ["a/n3.md", "a/n1.md", "a/n2.md"]);

    assert.deepEqual(hashes1, hashes2, "order of inputs should not affect sorted output");
    assert.deepEqual(hashes1, [...hashes1].sort(), "output should be sorted");
  });

  test("different file contents produce different hashes", async () => {
    const { hashSources } = await import("../../learn/sourceHashes.js");

    await writeFile("diff/n1.md", "unique content alpha");
    await writeFile("diff/n2.md", "unique content beta");
    await writeFile("diff/n3.md", "unique content gamma");

    const hashes = await hashSources(root(), ["diff/n1.md", "diff/n2.md", "diff/n3.md"]);
    const unique = new Set(hashes);
    assert.equal(unique.size, 3, "each unique file should produce a unique hash");
  });

  test("same contents produce same hashes (deterministic)", async () => {
    const { hashSources } = await import("../../learn/sourceHashes.js");

    await writeFile("det/n1.md", "same content");
    await writeFile("det/n2.md", "same content");
    await writeFile("det/n3.md", "same content");

    const h1 = await hashSources(root(), ["det/n1.md", "det/n2.md", "det/n3.md"]);
    const h2 = await hashSources(root(), ["det/n1.md", "det/n2.md", "det/n3.md"]);

    assert.deepEqual(h1, h2, "same inputs should always produce same output");
  });
});

describe("readExistingSummary", () => {
  test("returns null when _summary.md does not exist", async () => {
    const { readExistingSummary } = await import("../../learn/sourceHashes.js");

    const result = await readExistingSummary(root(), "ideas/absent");
    assert.equal(result, null);
  });

  test("returns null for a file without type: cluster-summary", async () => {
    const { readExistingSummary } = await import("../../learn/sourceHashes.js");

    await writeFile(
      "ideas/user/note.md",
      "---\ntitle: User Note\n---\nsome content\n"
    );
    // Write _summary.md without the type marker.
    await writeFile(
      "ideas/user/_summary.md",
      "---\ntitle: My Hand-Written Summary\n---\nsome content\n"
    );

    const result = await readExistingSummary(root(), "ideas/user");
    assert.equal(result, null, "should return null when type field is absent/wrong");
  });

  test("parses sourceHashes, generator, model, contentHash from valid summary", async () => {
    const { readExistingSummary } = await import("../../learn/sourceHashes.js");

    const summaryContent = `---
type: cluster-summary
generator: kb-learn@0.1.0
cluster: ideas/ml
generatedAt: "2026-04-16T00:00:00.000Z"
sourceCount: 2
sourceHashes:
  - aabbcc
  - ddeeff
model: extractive
sources:
  - ideas/ml/n1.md
  - ideas/ml/n2.md
organize: false
pinned: true
---
# Summary — ml

## Themes

- machine learning
`;

    await writeFile("ideas/ml/_summary.md", summaryContent);

    const result = await readExistingSummary(root(), "ideas/ml");
    assert.ok(result !== null, "should return non-null for valid summary");
    assert.deepEqual(result.sourceHashes, ["aabbcc", "ddeeff"]);
    assert.equal(result.generator, "kb-learn@0.1.0");
    assert.equal(result.model, "extractive");
    assert.equal(result.contentHash.length, 64, "contentHash should be a 64-char SHA-256");

    // Verify contentHash matches actual file bytes.
    const buf = await fs.readFile(path.join(root(), "ideas/ml/_summary.md"));
    const expected = crypto.createHash("sha256").update(buf).digest("hex");
    assert.equal(result.contentHash, expected);
  });

  test("F2 fix: model is null (not empty string) when field is absent", async () => {
    const { readExistingSummary } = await import("../../learn/sourceHashes.js");

    // Summary without a model field — simulates a hand-crafted or old-format summary.
    const summaryContent = `---
type: cluster-summary
generator: kb-learn@0.1.0
cluster: ideas/nomodel
generatedAt: "2026-04-16T00:00:00.000Z"
sourceCount: 1
sourceHashes:
  - aabbcc
sources:
  - ideas/nomodel/n1.md
organize: false
pinned: true
---
# Summary — nomodel
`;

    await writeFile("ideas/nomodel/_summary.md", summaryContent);

    const result = await readExistingSummary(root(), "ideas/nomodel");
    assert.ok(result !== null);
    // F2: model must be null so that the ?? fallback in classifyStatus fires
    // and hand-crafted summaries aren't always classified stale.
    assert.equal(result.model, null, "model should be null when field is absent");
  });

  test("tolerates missing sourceHashes field (returns empty array)", async () => {
    const { readExistingSummary } = await import("../../learn/sourceHashes.js");

    const summaryContent = `---
type: cluster-summary
generator: kb-learn@0.1.0
cluster: ideas/nohash
generatedAt: "2026-04-16T00:00:00.000Z"
sourceCount: 0
model: extractive
organize: false
pinned: true
---
# Summary — nohash
`;

    await writeFile("ideas/nohash/_summary.md", summaryContent);

    const result = await readExistingSummary(root(), "ideas/nohash");
    assert.ok(result !== null);
    assert.deepEqual(result.sourceHashes, [], "should return empty array when sourceHashes is missing");
  });
});

describe("hashBytes", () => {
  test("produces correct SHA-256 of a buffer", async () => {
    const { hashBytes } = await import("../../learn/sourceHashes.js");

    const content = "hello, world!\n";
    const buf = Buffer.from(content, "utf8");
    const result = await hashBytes(buf);
    const expected = crypto.createHash("sha256").update(buf).digest("hex");

    assert.equal(result, expected);
    assert.equal(result.length, 64);
  });
});
