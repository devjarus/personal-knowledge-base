/**
 * Tests for organize/classifier.ts — classifyByFrontmatter()
 *
 * Run with: pnpm test (tsx runner, node:test)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { NoteSummary } from "../types.js";

async function getClassifier() {
  const { classifyByFrontmatter } = await import("../organize/classifier.js");
  return classifyByFrontmatter;
}

function makeSummary(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    path: "test/note.md",
    slug: "note",
    title: "Test Note",
    tags: [],
    mtime: new Date().toISOString(),
    size: 100,
    preview: "",
    ...overrides,
  };
}

describe("classifyByFrontmatter — type field", () => {
  test("type: daily → { folder: 'daily', reason: 'type', confidence: 1.0 }", async () => {
    const classify = await getClassifier();
    const result = classify(makeSummary({ type: "daily" }), new Set());
    assert.ok(result !== null);
    assert.equal(result!.folder, "daily");
    assert.equal(result!.reason, "type");
    assert.equal(result!.confidence, 1.0);
  });

  test("type: project → { folder: 'project', reason: 'type', confidence: 1.0 }", async () => {
    const classify = await getClassifier();
    const result = classify(makeSummary({ type: "project" }), new Set());
    assert.ok(result !== null);
    assert.equal(result!.folder, "project");
    assert.equal(result!.reason, "type");
  });
});

describe("classifyByFrontmatter — tags field", () => {
  test("tags: [agents, memory] → { folder: 'agents', reason: 'tag', confidence: 1.0 }", async () => {
    const classify = await getClassifier();
    const result = classify(makeSummary({ tags: ["agents", "memory"] }), new Set());
    assert.ok(result !== null);
    assert.equal(result!.folder, "agents");
    assert.equal(result!.reason, "tag");
    assert.equal(result!.confidence, 1.0);
  });
});

describe("classifyByFrontmatter — type wins over tags", () => {
  test("type AND tags present → type wins (spec edge case #1)", async () => {
    const classify = await getClassifier();
    const result = classify(
      makeSummary({ type: "daily", tags: ["agents", "memory"] }),
      new Set()
    );
    assert.ok(result !== null);
    assert.equal(result!.folder, "daily");
    assert.equal(result!.reason, "type");
  });
});

describe("classifyByFrontmatter — no signal", () => {
  test("neither type nor tags → returns null (cluster fallback)", async () => {
    const classify = await getClassifier();
    const result = classify(makeSummary({ type: undefined, tags: [] }), new Set());
    assert.equal(result, null);
  });
});

describe("classifyByFrontmatter — tag tie-breaker", () => {
  test("tags: [foo, bar] and foo/ exists → foo wins (stability)", async () => {
    const classify = await getClassifier();
    const existingFolders = new Set(["foo"]);
    const result = classify(
      makeSummary({ tags: ["bar", "foo"] }),
      existingFolders
    );
    assert.ok(result !== null);
    assert.equal(result!.folder, "foo");
    assert.equal(result!.reason, "tag");
  });

  test("tags: [foo, bar] and bar/ exists → bar wins (stability)", async () => {
    const classify = await getClassifier();
    const existingFolders = new Set(["bar"]);
    const result = classify(
      makeSummary({ tags: ["foo", "bar"] }),
      existingFolders
    );
    assert.ok(result !== null);
    assert.equal(result!.folder, "bar");
    assert.equal(result!.reason, "tag");
  });

  test("tags: [foo, bar] and neither folder exists → first tag wins", async () => {
    const classify = await getClassifier();
    const result = classify(
      makeSummary({ tags: ["foo", "bar"] }),
      new Set()
    );
    assert.ok(result !== null);
    assert.equal(result!.folder, "foo");
  });
});
