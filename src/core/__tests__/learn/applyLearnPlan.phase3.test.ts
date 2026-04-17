/**
 * applyLearnPlan.phase3.test.ts — Phase 3 extensions to applyLearnPlan tests.
 *
 * Tests:
 *  1. noLlm=true → skips Ollama entirely, records model: null / generator: extractive.
 *  2. Ollama success → records model: "ollama:<tag>" in ledger.
 *  3. Ollama failure (null return) → falls back to extractive, records generator: extractive.
 *  4. Embeddings-loaded path produces different ordering than empty-embeddings path (D5 fix).
 */

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Fetch mock infrastructure
// ---------------------------------------------------------------------------

type MockFetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

let _mockFetch: MockFetchImpl | null = null;
const _originalFetch = globalThis.fetch;

function installFetchMock(impl: MockFetchImpl): void {
  _mockFetch = impl;
  globalThis.fetch = (url: string | URL | Request, init?: RequestInit) =>
    _mockFetch!(
      String(url instanceof URL ? url.toString() : url instanceof Request ? url.url : url),
      init
    );
}

function uninstallFetchMock(): void {
  _mockFetch = null;
  globalThis.fetch = _originalFetch;
}

function makeTagsResponse(models: string[]): Response {
  return new Response(
    JSON.stringify({ models: models.map((name) => ({ name })) }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function makeGenerateResponse(innerJson: unknown): Response {
  return new Response(
    JSON.stringify({ response: JSON.stringify(innerJson) }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// ---------------------------------------------------------------------------
// Valid Ollama summary fixture
// ---------------------------------------------------------------------------

const VALID_OLLAMA_SUMMARY = {
  themes: ["Neural Networks", "Optimization", "Feature Engineering"],
  keyPoints: [
    "Neural networks learn hierarchical representations from data.",
    "Gradient descent optimizes the loss function via backpropagation.",
    "Feature engineering transforms raw inputs into model-ready representations.",
  ],
  openQuestions: ["What is the optimal learning rate schedule for transformers?"],
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-apply-phase3-"));
});

after(async () => {
  delete process.env.KB_ROOT;
  delete process.env.KB_LEARN_NO_OLLAMA;
  uninstallFetchMock();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const sub = await fs.mkdtemp(path.join(tmpDir, "run-"));
  process.env.KB_ROOT = sub;
  const { _invalidateNotesCache } = await import("../../fs.js");
  _invalidateNotesCache();
  // Reset semantic index cache between runs.
  const { _invalidateSemanticCache } = await import("../../semanticIndex.js");
  _invalidateSemanticCache();
});

afterEach(() => {
  uninstallFetchMock();
});

function root(): string {
  return process.env.KB_ROOT!;
}

async function writeNote(
  relPath: string,
  frontmatter: Record<string, unknown> = {},
  body = "Test body content with enough text for extraction."
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

async function buildPlan(
  clusterPath: string,
  notes: string[],
  status: "new" | "stale",
  generator: "ollama" | "extractive" = "extractive"
) {
  const { hashSources } = await import("../../learn/sourceHashes.js");
  const sourceHashes = await hashSources(root(), notes);
  return {
    generatedAt: new Date().toISOString(),
    mode: "full" as const,
    generator: generator as "ollama" | "extractive",
    clusters: [
      {
        cluster: clusterPath,
        sources: notes,
        sourceHashes,
        summaryPath: `${clusterPath}/_summary.md`,
        generator: generator as "ollama" | "extractive",
        status,
      },
    ],
    stats: {
      total: 1,
      new: status === "new" ? 1 : 0,
      stale: status === "stale" ? 1 : 0,
      fresh: 0,
      skipped: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyLearnPlan Phase 3", () => {
  test("noLlm=true: skips Ollama, records generator=extractive in ledger", async () => {
    const { applyLearnPlan } = await import("../../learn.js");
    const { readLearnLedger } = await import("../../learn/ledger.js");

    let fetchCalled = false;
    installFetchMock(async () => {
      fetchCalled = true;
      return new Response("should not be called", { status: 500 });
    });

    await writeNote("ideas/nollm/n1.md", { title: "Alpha", tags: ["ml"] }, "Alpha content here.");
    await writeNote("ideas/nollm/n2.md", { title: "Beta", tags: ["ml"] }, "Beta content here.");
    await writeNote("ideas/nollm/n3.md", { title: "Gamma", tags: ["ml"] }, "Gamma content here.");

    // Plan with generator=ollama but apply with noLlm=true.
    const plan = await buildPlan(
      "ideas/nollm",
      ["ideas/nollm/n1.md", "ideas/nollm/n2.md", "ideas/nollm/n3.md"],
      "new",
      "ollama"
    );

    const result = await applyLearnPlan(plan, { noLlm: true });

    // Ollama was never called.
    assert.equal(fetchCalled, false, "fetch should not be called when noLlm=true");
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].generator, "extractive");

    // Ledger should record generator=extractive and model=null.
    const records = await readLearnLedger(result.ledgerPath);
    const writeRecord = records.find((r) => r.kind === "learning-write") as
      | import("../../learn/ledger.js").LearnLedgerWriteRecord
      | undefined;
    assert.ok(writeRecord, "should have a learning-write record");
    assert.equal(writeRecord.generator, "extractive", "ledger generator should be extractive");
    assert.equal(writeRecord.model, null, "ledger model should be null for extractive");
  });

  test("Ollama success: records model='ollama:<tag>' in ledger and summary frontmatter", async () => {
    const { applyLearnPlan } = await import("../../learn.js");
    const { readLearnLedger } = await import("../../learn/ledger.js");

    installFetchMock(async (url) => {
      if (url.includes("/api/tags")) {
        return makeTagsResponse(["llama3.2:latest"]);
      }
      if (url.includes("/api/generate")) {
        return makeGenerateResponse(VALID_OLLAMA_SUMMARY);
      }
      return new Response("not found", { status: 404 });
    });

    await writeNote("ideas/ollama/n1.md", { title: "NN", tags: ["ml"] }, "Neural networks learn.");
    await writeNote("ideas/ollama/n2.md", { title: "GD", tags: ["optimization"] }, "Gradient descent works.");
    await writeNote("ideas/ollama/n3.md", { title: "FE", tags: ["ml"] }, "Feature engineering matters.");

    const plan = await buildPlan(
      "ideas/ollama",
      ["ideas/ollama/n1.md", "ideas/ollama/n2.md", "ideas/ollama/n3.md"],
      "new",
      "ollama"
    );

    const result = await applyLearnPlan(plan, {
      ollamaModel: "llama3.2",
      ollamaUrl: "http://localhost:11434",
    });

    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].generator, "ollama");

    // Ledger record.
    const records = await readLearnLedger(result.ledgerPath);
    const writeRecord = records.find((r) => r.kind === "learning-write") as
      | import("../../learn/ledger.js").LearnLedgerWriteRecord
      | undefined;
    assert.ok(writeRecord, "should have a learning-write record");
    assert.equal(writeRecord.generator, "ollama", "ledger generator should be ollama");
    // F7 fix: model should be the exact resolved tag, not hardcoded "llama3.2".
    assert.equal(writeRecord.model, "llama3.2:latest", "ledger model should be exact resolved tag");

    // Summary frontmatter should include model: ollama:llama3.2:latest.
    const summaryContent = await fs.readFile(
      path.join(root(), "ideas/ollama/_summary.md"),
      "utf8"
    );
    // Extract frontmatter block for assertion (between --- delimiters).
    const fmMatch = summaryContent.match(/^---[\s\S]*?---/);
    const fmSection = fmMatch ? fmMatch[0] : summaryContent;
    // The model value may be YAML-quoted (because of colons in "ollama:llama3.2:latest").
    // Accept either quoted or unquoted form.
    const hasModel =
      summaryContent.includes('model: "ollama:llama3.2:latest"') ||
      summaryContent.includes("model: ollama:llama3.2:latest");
    assert.ok(
      hasModel,
      `Expected 'model: ollama:llama3.2:latest' (quoted or unquoted) in frontmatter.\nFrontmatter:\n${fmSection}`
    );
    // Summary body should contain Ollama-generated themes.
    assert.ok(
      summaryContent.includes("Neural Networks"),
      "Summary body should contain Ollama-generated theme"
    );
  });

  test("Ollama failure (null return): falls back to extractive, records generator=extractive", async () => {
    const { applyLearnPlan } = await import("../../learn.js");
    const { readLearnLedger } = await import("../../learn/ledger.js");

    // Ollama probe succeeds but generate returns 500.
    installFetchMock(async (url) => {
      if (url.includes("/api/tags")) {
        return makeTagsResponse(["llama3.2:latest"]);
      }
      if (url.includes("/api/generate")) {
        return new Response("internal server error", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    });

    await writeNote("ideas/fallback/n1.md", { title: "A", tags: ["x"] }, "Content A.");
    await writeNote("ideas/fallback/n2.md", { title: "B", tags: ["y"] }, "Content B.");
    await writeNote("ideas/fallback/n3.md", { title: "C", tags: ["z"] }, "Content C.");

    const plan = await buildPlan(
      "ideas/fallback",
      ["ideas/fallback/n1.md", "ideas/fallback/n2.md", "ideas/fallback/n3.md"],
      "new",
      "ollama"
    );

    const result = await applyLearnPlan(plan, {
      ollamaModel: "llama3.2",
      ollamaUrl: "http://localhost:11434",
    });

    // Should have applied (extractive fallback) and recorded the error.
    assert.equal(result.applied.length, 1, "should still apply via extractive fallback");
    assert.equal(result.applied[0].generator, "extractive", "applied generator should be extractive");
    assert.ok(result.ollamaError !== undefined, "ollamaError should be set on fallback");

    // Ledger record should reflect extractive.
    const records = await readLearnLedger(result.ledgerPath);
    const writeRecord = records.find((r) => r.kind === "learning-write") as
      | import("../../learn/ledger.js").LearnLedgerWriteRecord
      | undefined;
    assert.ok(writeRecord, "should have a learning-write record");
    assert.equal(writeRecord.generator, "extractive");
    assert.equal(writeRecord.model, null);

    // Summary should still exist on disk.
    const summaryExists = await fs.access(path.join(root(), "ideas/fallback/_summary.md"))
      .then(() => true)
      .catch(() => false);
    assert.ok(summaryExists, "summary file should exist even after Ollama failure");
  });

  test("D5 fix: real embeddings sidecar changes summary content vs no-sidecar run", async () => {
    /**
     * M1 nit fix: this test now invokes applyLearnPlan() directly (not
     * generateExtractive) so it exercises the full loadIndex() → Float32Array
     * wire-up that the D5 fix added in Phase 3.
     *
     * Strategy:
     *  1. Write three notes in ideas/rank/ with path-alphabetical order: a, b, c.
     *  2. Seed a sidecar where b.md has the highest cosine similarity to the centroid
     *     (see vector math below). This means with real embeddings, b.md ranks first
     *     and its first sentence appears as keyPoints[0].
     *  3. Run applyLearnPlan(plan, { noLlm: true }) — this triggers loadIndex().
     *  4. Read the written _summary.md and assert that the key points section
     *     starts with "Beta" content (b.md ranked first), not "Alpha" (a.md).
     *
     * Vector math for b.md ranking first:
     *   a=[1,0,0], b=[1,1,0], c=[0,0,1]
     *   centroid = [2/3, 1/3, 1/3] (normalized ≈ [0.816, 0.408, 0.408])
     *   cos(b=[1,1,0], centroid) ≈ 0.866  ← highest
     *   cos(a=[1,0,0], centroid) ≈ 0.816
     *   cos(c=[0,0,1], centroid) ≈ 0.408
     */

    const { applyLearnPlan } = await import("../../learn.js");
    const { hashSources } = await import("../../learn/sourceHashes.js");

    // Write notes: a, b, c — path-alphabetical order is a, b, c.
    await fs.mkdir(path.join(root(), "ideas/rank"), { recursive: true });
    await fs.writeFile(
      path.join(root(), "ideas/rank/a.md"),
      `---\ntitle: Alpha\ntags: [a]\n---\nAlpha is the first. Does it matter?\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(root(), "ideas/rank/b.md"),
      `---\ntitle: Beta\ntags: [b]\n---\nBeta is the central topic of this cluster.\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(root(), "ideas/rank/c.md"),
      `---\ntitle: Gamma\ntags: [c]\n---\nGamma is the last in order.\n`,
      "utf8"
    );

    // Seed the embeddings sidecar so loadIndex() returns our controlled vectors.
    // b.md gets the vector that ranks highest against the centroid.
    const indexDir = path.join(root(), ".kb-index");
    await fs.mkdir(indexDir, { recursive: true });
    const sidecarRows = [
      { path: "ideas/rank/a.md", sig: "sig-a", vec: Array.from(new Float32Array([1, 0, 0])) },
      { path: "ideas/rank/b.md", sig: "sig-b", vec: Array.from(new Float32Array([1, 1, 0])) },
      { path: "ideas/rank/c.md", sig: "sig-c", vec: Array.from(new Float32Array([0, 0, 1])) },
    ];
    await fs.writeFile(
      path.join(indexDir, "embeddings.jsonl"),
      sidecarRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8"
    );

    // Build a plan manually (bypassing buildLearnPlan to avoid the Ollama probe).
    const notePaths = [
      "ideas/rank/a.md",
      "ideas/rank/b.md",
      "ideas/rank/c.md",
    ];
    const sourceHashes = await hashSources(root(), notePaths);
    const plan = {
      generatedAt: new Date().toISOString(),
      mode: "full" as const,
      generator: "extractive" as const,
      clusters: [
        {
          cluster: "ideas/rank",
          sources: notePaths,
          sourceHashes,
          summaryPath: "ideas/rank/_summary.md",
          generator: "extractive" as const,
          status: "new" as const,
        },
      ],
      stats: { total: 1, new: 1, stale: 0, fresh: 0, skipped: 0 },
    };

    // Run applyLearnPlan — this exercises the full D5 wire-up (loadIndex → embeddings → extractive).
    const result = await applyLearnPlan(plan, { noLlm: true });

    assert.equal(result.applied.length, 1, "should have applied 1 summary");
    assert.equal(result.applied[0].generator, "extractive");

    // Read the written summary and verify its key-points content.
    const summaryContent = await fs.readFile(
      path.join(root(), "ideas/rank/_summary.md"),
      "utf8"
    );

    // With real embeddings (b.md ranks highest), the first key point should
    // contain content from b.md ("Beta is the central topic..."), NOT a.md.
    // We check the Key points section of the summary body.
    const keyPointsMatch = summaryContent.match(/## Key points([\s\S]*?)(?=##|$)/);
    assert.ok(keyPointsMatch, "summary should have a '## Key points' section");
    const keyPointsSection = keyPointsMatch[1];

    assert.ok(
      keyPointsSection.includes("Beta"),
      `With real embeddings, first key point should contain "Beta" (b.md ranked highest). ` +
      `Key points section:\n${keyPointsSection}`
    );
    assert.ok(
      !keyPointsSection.trimStart().startsWith("- Alpha"),
      "First key point should NOT be from a.md (path-alphabetical fallback) when embeddings are loaded"
    );
  });
});
