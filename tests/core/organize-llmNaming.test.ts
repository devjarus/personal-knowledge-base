/**
 * Tests for organize/llmNaming.ts — nameClusters()
 *
 * All tests pass `{ noOllama: true }` so we never probe a real Ollama
 * instance (even if one is running locally). That leaves Flan-T5 as the
 * top tier; the Flan-T5 model (Xenova/flan-t5-small) may or may not be
 * cached on the test machine. Tests verify slug-safety, deduplication,
 * and array shapes — passing regardless of which tier actually produces
 * the names.
 *
 * See organize-ollamaNaming.test.ts for fetch-mocked tests of the
 * Ollama-enabled path.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { nameClusters, _resetGenerator } from "@/core/organize/llmNaming.js";
import type { ClusterForNaming } from "@/core/organize/llmNaming.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCluster(opts: Partial<ClusterForNaming> = {}): ClusterForNaming {
  return {
    memberTitles: ["Note One", "Note Two", "Note Three"],
    memberTags: ["typescript", "testing"],
    topTermsTfIdf: ["typescript", "testing", "patterns"],
    memberCount: 3,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("nameClusters — basic behavior", () => {
  test("returns empty array for empty cluster list", async () => {
    const result = await nameClusters([], new Set(), { noOllama: true });
    assert.deepEqual(result, []);
  });

  test("returns one slug-safe name per cluster", async () => {
    const clusters = [
      makeCluster({ topTermsTfIdf: ["typescript", "testing"] }),
      makeCluster({ topTermsTfIdf: ["memory", "cache"] }),
    ];

    const result = await nameClusters(clusters, new Set(), { noOllama: true });

    assert.equal(result.length, clusters.length, "One name per cluster");
    for (const name of result) {
      assert.match(name, /^[a-z0-9][a-z0-9-]*$/, `"${name}" is not slug-safe`);
      assert.ok(name.length > 0, "Name should not be empty");
    }
  });

  test("returns unique names when same terms repeat", async () => {
    const clusters = [
      makeCluster({ topTermsTfIdf: ["testing", "patterns"] }),
      makeCluster({ topTermsTfIdf: ["testing", "patterns"] }),
      makeCluster({ topTermsTfIdf: ["testing", "patterns"] }),
    ];

    const result = await nameClusters(clusters, new Set(), { noOllama: true });

    assert.equal(result.length, 3);
    const unique = new Set(result);
    assert.equal(unique.size, 3, `Expected 3 unique names, got: [${result.join(", ")}]`);
  });

  test("avoids collision with existingFolders", async () => {
    const clusters = [
      makeCluster({
        memberTitles: ["Agent config", "Agent setup"],
        memberTags: ["agents"],
        topTermsTfIdf: ["agents", "tools"],
      }),
    ];

    const existingFolders = new Set(["agents", "agents-tools"]);
    const result = await nameClusters(clusters, existingFolders, { noOllama: true });

    assert.equal(result.length, 1);
    // The name must NOT be "agents" or "agents-tools" (both are taken).
    assert.ok(
      !existingFolders.has(result[0]),
      `Name "${result[0]}" collides with existing folder`,
    );
  });

  test("handles cluster with empty topTermsTfIdf and tags", async () => {
    const clusters = [
      makeCluster({
        memberTitles: ["Untitled"],
        memberTags: [],
        topTermsTfIdf: [],
      }),
    ];

    const result = await nameClusters(clusters, new Set(), { noOllama: true });

    assert.equal(result.length, 1);
    assert.match(result[0], /^[a-z0-9][a-z0-9-]*$/, "Should be slug-safe");
  });

  test("handles weird characters in terms gracefully", async () => {
    const clusters = [
      makeCluster({ topTermsTfIdf: ["C++", "System.IO", "über"] }),
    ];

    const result = await nameClusters(clusters, new Set(), { noOllama: true });

    assert.equal(result.length, 1);
    assert.match(result[0], /^[a-z0-9][a-z0-9-]*$/, `"${result[0]}" is not slug-safe`);
  });

  test("many clusters all get unique names", async () => {
    const clusters = Array.from({ length: 15 }, (_, i) =>
      makeCluster({
        memberTitles: [`Topic ${i} note A`, `Topic ${i} note B`],
        topTermsTfIdf: ["common", "shared", "terms"],
      }),
    );

    const result = await nameClusters(clusters, new Set(), { noOllama: true });

    assert.equal(result.length, 15);
    const unique = new Set(result);
    assert.equal(unique.size, 15, `All 15 names must be unique: [${result.join(", ")}]`);
  });
});
