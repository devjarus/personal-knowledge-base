/**
 * prompts.test.ts — Unit tests for the prompt builder.
 *
 * Tests:
 *   1. buildPrompt output contains cluster name
 *   2. buildPrompt output contains all note titles
 *   3. buildPrompt includes an excerpt for each note
 *   4. Excerpts are truncated to 400 chars
 *   5. Input capped at 30 notes
 *   6. generatedSummarySchema validates valid objects
 *   7. generatedSummarySchema rejects invalid objects
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, generatedSummarySchema } from "../../learn/prompts.js";
import type { PromptInput } from "../../learn/prompts.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildPrompt — content", () => {
  test("output contains cluster name", () => {
    const input: PromptInput = {
      clusterName: "machine-learning",
      notes: [
        { path: "ml/note.md", title: "Attention", tags: ["ml"], excerpt: "Attention mechanisms." },
      ],
    };
    const { user } = buildPrompt(input);
    assert.ok(user.includes("machine-learning"), `cluster name missing from user prompt`);
  });

  test("output contains all note titles", () => {
    const input: PromptInput = {
      clusterName: "cluster",
      notes: [
        { path: "a.md", title: "Title Alpha", tags: [], excerpt: "Excerpt A." },
        { path: "b.md", title: "Title Beta", tags: [], excerpt: "Excerpt B." },
        { path: "c.md", title: "Title Gamma", tags: [], excerpt: "Excerpt C." },
      ],
    };
    const { user } = buildPrompt(input);
    assert.ok(user.includes("Title Alpha"), "Title Alpha missing");
    assert.ok(user.includes("Title Beta"), "Title Beta missing");
    assert.ok(user.includes("Title Gamma"), "Title Gamma missing");
  });

  test("output includes excerpt for each note", () => {
    const input: PromptInput = {
      clusterName: "cluster",
      notes: [
        { path: "a.md", title: "A", tags: [], excerpt: "Content of note A." },
        { path: "b.md", title: "B", tags: [], excerpt: "Content of note B." },
      ],
    };
    const { user } = buildPrompt(input);
    assert.ok(user.includes("Content of note A."), "excerpt A missing");
    assert.ok(user.includes("Content of note B."), "excerpt B missing");
  });

  test("excerpts are truncated to 400 chars", () => {
    const longExcerpt = "X".repeat(500);
    const input: PromptInput = {
      clusterName: "cluster",
      notes: [{ path: "a.md", title: "A", tags: [], excerpt: longExcerpt }],
    };
    const { user } = buildPrompt(input);
    // The full 500-char string should NOT appear.
    assert.ok(!user.includes("X".repeat(401)), "excerpt was not truncated to 400 chars");
    // The first 400 chars SHOULD appear.
    assert.ok(user.includes("X".repeat(400)), "first 400 chars should appear");
  });

  test("input is capped at 30 notes", () => {
    const notes = Array.from({ length: 40 }, (_, i) => ({
      path: `note${i}.md`,
      title: `Note ${i}`,
      tags: [],
      excerpt: `Excerpt for note ${i}.`,
    }));
    const input: PromptInput = { clusterName: "cluster", notes };
    const { user } = buildPrompt(input);
    // Note at index 30 should NOT appear.
    assert.ok(!user.includes("Excerpt for note 30."), "note 30 should be excluded (cap at 30)");
    // Note at index 29 SHOULD appear.
    assert.ok(user.includes("Excerpt for note 29."), "note 29 should be included");
  });

  test("note count in prompt reflects capped count, not original count", () => {
    const notes = Array.from({ length: 40 }, (_, i) => ({
      path: `note${i}.md`,
      title: `Note ${i}`,
      tags: [],
      excerpt: `Excerpt ${i}.`,
    }));
    const input: PromptInput = { clusterName: "cluster", notes };
    const { user } = buildPrompt(input);
    // Should say "Notes (30):" not "Notes (40):".
    assert.ok(user.includes("Notes (30):"), `expected 'Notes (30):' in user prompt`);
    assert.ok(!user.includes("Notes (40):"), "should not show uncapped count");
  });

  test("system prompt is non-empty and contains JSON schema hint", () => {
    const input: PromptInput = {
      clusterName: "cluster",
      notes: [{ path: "a.md", title: "A", tags: [], excerpt: "Excerpt." }],
    };
    const { system } = buildPrompt(input);
    assert.ok(system.length > 50, "system prompt is too short");
    assert.ok(system.includes("themes"), "system prompt should mention themes");
    assert.ok(system.includes("keyPoints"), "system prompt should mention keyPoints");
    assert.ok(system.includes("openQuestions"), "system prompt should mention openQuestions");
  });

  test("tags are included in note blocks", () => {
    const input: PromptInput = {
      clusterName: "cluster",
      notes: [{ path: "a.md", title: "A", tags: ["ml", "python"], excerpt: "Excerpt." }],
    };
    const { user } = buildPrompt(input);
    assert.ok(user.includes("ml, python"), "tags should appear in note block");
  });

  test("empty tags show as 'none'", () => {
    const input: PromptInput = {
      clusterName: "cluster",
      notes: [{ path: "a.md", title: "A", tags: [], excerpt: "Excerpt." }],
    };
    const { user } = buildPrompt(input);
    assert.ok(user.includes("none"), "empty tags should show as 'none'");
  });
});

describe("generatedSummarySchema", () => {
  test("validates a well-formed GeneratedSummary", () => {
    const result = generatedSummarySchema.safeParse({
      themes: ["AI", "Machine Learning"],
      keyPoints: ["Transformers are powerful."],
      openQuestions: ["How does scaling work?"],
    });
    assert.ok(result.success, `schema rejected valid input: ${JSON.stringify(result)}`);
  });

  test("rejects empty themes array", () => {
    const result = generatedSummarySchema.safeParse({
      themes: [],
      keyPoints: ["A point."],
      openQuestions: [],
    });
    assert.ok(!result.success, "should reject empty themes");
  });

  test("rejects empty keyPoints array", () => {
    const result = generatedSummarySchema.safeParse({
      themes: ["AI"],
      keyPoints: [],
      openQuestions: [],
    });
    assert.ok(!result.success, "should reject empty keyPoints");
  });

  test("allows empty openQuestions array", () => {
    const result = generatedSummarySchema.safeParse({
      themes: ["AI"],
      keyPoints: ["A point."],
      openQuestions: [],
    });
    assert.ok(result.success, "should allow empty openQuestions");
  });

  test("rejects themes with > 10 items", () => {
    const result = generatedSummarySchema.safeParse({
      themes: Array.from({ length: 11 }, (_, i) => `Theme ${i}`),
      keyPoints: ["A point."],
      openQuestions: [],
    });
    assert.ok(!result.success, "should reject > 10 themes");
  });

  test("rejects keyPoints with > 15 items", () => {
    const result = generatedSummarySchema.safeParse({
      themes: ["AI"],
      keyPoints: Array.from({ length: 16 }, (_, i) => `Point ${i}.`),
      openQuestions: [],
    });
    assert.ok(!result.success, "should reject > 15 keyPoints");
  });

  test("rejects openQuestions with > 10 items", () => {
    const result = generatedSummarySchema.safeParse({
      themes: ["AI"],
      keyPoints: ["A point."],
      openQuestions: Array.from({ length: 11 }, (_, i) => `Question ${i}?`),
    });
    assert.ok(!result.success, "should reject > 10 openQuestions");
  });

  test("rejects missing required fields", () => {
    const result = generatedSummarySchema.safeParse({ themes: ["AI"] });
    assert.ok(!result.success, "should reject object missing keyPoints and openQuestions");
  });
});
