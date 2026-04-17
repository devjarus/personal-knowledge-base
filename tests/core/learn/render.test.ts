/**
 * render.test.ts — Unit tests for the summary renderer.
 *
 * Tests:
 *   1. Frontmatter contains required fields: type, generator, cluster, generatedAt, etc.
 *   2. type: cluster-summary is always present
 *   3. organize: false and pinned: true are always present
 *   4. Sources section lists all paths as wiki-links
 *   5. H1 matches cluster basename
 *   6. Themes and key points are rendered as bullet lists
 *   7. Open questions section is omitted when empty
 *   8. Frontmatter round-trips through gray-matter (parseable)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import matter from "gray-matter";
import { renderSummary } from "@/core/learn/render.js";
import type { RenderInput } from "@/core/learn/render.js";

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function makeRenderInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    clusterName: "machine-learning",
    cluster: "ideas/machine-learning",
    sources: ["ideas/machine-learning/attention.md", "ideas/machine-learning/embeddings.md", "ideas/machine-learning/backprop.md"],
    sourceHashes: ["aaa111", "bbb222", "ccc333"],
    generator: "extractive",
    model: null,
    summary: {
      themes: ["Neural Networks", "Embeddings", "Backpropagation"],
      keyPoints: ["Transformers use attention to relate tokens.", "Embeddings map words to vectors."],
      openQuestions: ["How does scaling affect performance?"],
    },
    generatedAt: "2026-04-16T14:22:05Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderSummary — frontmatter structure", () => {
  test("output starts with --- and is parseable by gray-matter", () => {
    const output = renderSummary(makeRenderInput());
    assert.ok(output.startsWith("---"), "output should start with ---");
    // gray-matter should parse without throwing.
    const parsed = matter(output);
    assert.ok(typeof parsed.data === "object");
  });

  test("required frontmatter fields are present", () => {
    const input = makeRenderInput();
    const output = renderSummary(input);
    const { data } = matter(output);

    assert.equal(data.type, "cluster-summary");
    assert.equal(data.generator, "kb-learn@0.1.0");
    assert.equal(data.cluster, "ideas/machine-learning");
    assert.equal(data.generatedAt, "2026-04-16T14:22:05Z");
    assert.equal(data.sourceCount, 3);
    assert.equal(data.model, "extractive");
    assert.equal(data.organize, false);
    assert.equal(data.pinned, true);
  });

  test("sourceHashes in frontmatter matches input", () => {
    const input = makeRenderInput();
    const output = renderSummary(input);
    const { data } = matter(output);
    assert.deepEqual(data.sourceHashes, ["aaa111", "bbb222", "ccc333"]);
  });

  test("sources in frontmatter matches input", () => {
    const input = makeRenderInput();
    const output = renderSummary(input);
    const { data } = matter(output);
    assert.deepEqual(data.sources, [
      "ideas/machine-learning/attention.md",
      "ideas/machine-learning/embeddings.md",
      "ideas/machine-learning/backprop.md",
    ]);
  });

  test("model field is 'extractive' for extractive generator", () => {
    const output = renderSummary(makeRenderInput({ generator: "extractive", model: null }));
    const { data } = matter(output);
    assert.equal(data.model, "extractive");
  });

  test("model field is 'ollama:<tag>' for ollama generator", () => {
    const output = renderSummary(makeRenderInput({ generator: "ollama", model: "llama3.2" }));
    const { data } = matter(output);
    assert.equal(data.model, "ollama:llama3.2");
  });
});

describe("renderSummary — markdown body", () => {
  test("H1 matches cluster basename", () => {
    const output = renderSummary(makeRenderInput());
    assert.ok(output.includes("# Summary — machine-learning"), `H1 not found in:\n${output}`);
  });

  test("H1 uses basename when cluster has nested path", () => {
    const output = renderSummary(makeRenderInput({ cluster: "projects/ai/subproject" }));
    assert.ok(output.includes("# Summary — subproject"), `expected '# Summary — subproject' in:\n${output}`);
  });

  test("themes appear as bullet list under ## Themes", () => {
    const output = renderSummary(makeRenderInput());
    assert.ok(output.includes("## Themes"), "Themes section missing");
    assert.ok(output.includes("- Neural Networks"), "theme bullet missing");
    assert.ok(output.includes("- Embeddings"), "theme bullet missing");
    assert.ok(output.includes("- Backpropagation"), "theme bullet missing");
  });

  test("key points appear as bullet list under ## Key points", () => {
    const output = renderSummary(makeRenderInput());
    assert.ok(output.includes("## Key points"), "Key points section missing");
    assert.ok(output.includes("- Transformers use attention to relate tokens."), "key point bullet missing");
  });

  test("open questions appear as bullet list when non-empty", () => {
    const output = renderSummary(makeRenderInput());
    assert.ok(output.includes("## Open questions"), "Open questions section missing");
    assert.ok(output.includes("- How does scaling affect performance?"), "open question bullet missing");
  });

  test("Open questions section is omitted when empty", () => {
    const input = makeRenderInput({
      summary: {
        themes: ["AI"],
        keyPoints: ["Point one."],
        openQuestions: [],
      },
    });
    const output = renderSummary(input);
    assert.ok(!output.includes("## Open questions"), "Open questions section should be absent");
  });

  test("Sources section lists all source paths as wiki-links", () => {
    const output = renderSummary(makeRenderInput());
    assert.ok(output.includes("## Sources"), "Sources section missing");
    assert.ok(output.includes("- [[ideas/machine-learning/attention.md]]"), "wiki-link missing");
    assert.ok(output.includes("- [[ideas/machine-learning/embeddings.md]]"), "wiki-link missing");
    assert.ok(output.includes("- [[ideas/machine-learning/backprop.md]]"), "wiki-link missing");
  });

  test("opt-out comment is present in output", () => {
    const output = renderSummary(makeRenderInput());
    assert.ok(output.includes("organize: false"), "opt-out comment not found");
  });
});

describe("renderSummary — gray-matter round-trip", () => {
  test("parsed frontmatter has organize:false and pinned:true boolean values", () => {
    const output = renderSummary(makeRenderInput());
    const { data } = matter(output);
    assert.strictEqual(data.organize, false);
    assert.strictEqual(data.pinned, true);
  });

  test("sourceCount matches sources.length", () => {
    const input = makeRenderInput();
    const output = renderSummary(input);
    const { data } = matter(output);
    assert.equal(data.sourceCount, input.sources.length);
  });
});
