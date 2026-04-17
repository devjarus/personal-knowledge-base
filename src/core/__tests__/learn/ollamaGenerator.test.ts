/**
 * ollamaGenerator.test.ts — Hermetic tests for src/core/learn/ollamaGenerator.ts.
 *
 * All tests mock globalThis.fetch — never hit real Ollama.
 *
 * Coverage:
 *  1. Happy path: valid JSON response → returns GeneratedSummary + resolvedModel.
 *  2. Probe fail (Ollama unreachable) → returns null.
 *  3. Model not installed → returns null.
 *  4. HTTP 500 from /api/generate → returns null.
 *  5. Non-JSON body from /api/generate → returns null.
 *  6. JSON that fails zod schema validation → returns null.
 *  7. Timeout (pre-aborted signal) → returns null.
 *  8. Malformed outer JSON (no "response" field) → returns null.
 *  9. Prefix-match model resolution (e.g. "llama3.2" matches "llama3.2:3b").
 * 10. Empty response string from Ollama → returns null.
 */

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Fetch mock infrastructure
// ---------------------------------------------------------------------------

type MockFetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

let _mockFetch: MockFetchImpl | null = null;
const _originalFetch = globalThis.fetch;

function installFetchMock(impl: MockFetchImpl): void {
  _mockFetch = impl;
  globalThis.fetch = (url: string | URL | Request, init?: RequestInit) =>
    _mockFetch!(String(url instanceof URL ? url.toString() : url instanceof Request ? url.url : url), init);
}

function uninstallFetchMock(): void {
  _mockFetch = null;
  globalThis.fetch = _originalFetch;
}

/** Helper: build a minimal Response-like object from Ollama. */
function makeTagsResponse(models: string[]): Response {
  const body = JSON.stringify({ models: models.map((name) => ({ name })) });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Helper: build a generate Response with the model's JSON embedded in "response". */
function makeGenerateResponse(innerJson: unknown): Response {
  const body = JSON.stringify({ response: JSON.stringify(innerJson) });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Helper: build a generate Response with a raw string in "response" (no inner JSON parse). */
function makeGenerateResponseRaw(responseStr: string): Response {
  const body = JSON.stringify({ response: responseStr });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Shared minimal PromptInput
// ---------------------------------------------------------------------------

const SAMPLE_INPUT = {
  clusterName: "machine-learning",
  notes: [
    {
      path: "ideas/ml/attention.md",
      title: "Attention Mechanisms",
      tags: ["ml", "transformers"],
      excerpt: "Attention allows models to focus on relevant parts of the input sequence.",
    },
    {
      path: "ideas/ml/embeddings.md",
      title: "Embeddings",
      tags: ["ml", "vectors"],
      excerpt: "Embeddings map discrete tokens to dense continuous vectors.",
    },
    {
      path: "ideas/ml/backprop.md",
      title: "Backpropagation",
      tags: ["ml", "optimization"],
      excerpt: "Backprop computes gradients via the chain rule. Is it still the best approach?",
    },
  ],
};

const VALID_SUMMARY = {
  themes: ["Attention Mechanisms", "Embeddings", "Backpropagation"],
  keyPoints: [
    "Attention allows models to focus on relevant parts of the input.",
    "Embeddings map tokens to dense vectors for downstream tasks.",
    "Backpropagation computes gradients via the chain rule.",
  ],
  openQuestions: ["Is backpropagation still the best approach?"],
};

const DEFAULT_OPTS = {
  model: "llama3.2",
  baseUrl: "http://localhost:11434",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ollamaGenerator", () => {
  afterEach(() => {
    uninstallFetchMock();
  });

  test("happy path: valid JSON response returns GeneratedSummary + resolvedModel", async () => {
    const { generateOllama } = await import("../../learn/ollamaGenerator.js");

    let generateCalled = false;
    installFetchMock(async (url) => {
      if (url.includes("/api/tags")) {
        return makeTagsResponse(["llama3.2:latest"]);
      }
      if (url.includes("/api/generate")) {
        generateCalled = true;
        return makeGenerateResponse(VALID_SUMMARY);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await generateOllama(SAMPLE_INPUT, DEFAULT_OPTS);
    assert.ok(result !== null, "should return a result on happy path");
    assert.ok(generateCalled, "should have called /api/generate");
    assert.deepEqual(result.summary.themes, VALID_SUMMARY.themes);
    assert.deepEqual(result.summary.keyPoints, VALID_SUMMARY.keyPoints);
    assert.deepEqual(result.summary.openQuestions, VALID_SUMMARY.openQuestions);
    // resolvedModel should be the exact tag installed (prefix-matched from "llama3.2")
    assert.equal(result.resolvedModel, "llama3.2:latest");
  });

  test("probe fail (Ollama unreachable) returns null", async () => {
    const { generateOllama } = await import("../../learn/ollamaGenerator.js");

    installFetchMock(async () => {
      throw new TypeError("fetch failed: connection refused");
    });

    const result = await generateOllama(SAMPLE_INPUT, DEFAULT_OPTS);
    assert.equal(result, null, "should return null when Ollama is unreachable");
  });

  test("model not installed returns null", async () => {
    const { generateOllama } = await import("../../learn/ollamaGenerator.js");

    installFetchMock(async (url) => {
      if (url.includes("/api/tags")) {
        // Returns a different model — not the requested one.
        return makeTagsResponse(["qwen2.5:3b"]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await generateOllama(SAMPLE_INPUT, {
      model: "llama3.2",
      baseUrl: "http://localhost:11434",
    });
    assert.equal(result, null, "should return null when model is not installed");
  });

  test("HTTP 500 from /api/generate returns null", async () => {
    const { generateOllama } = await import("../../learn/ollamaGenerator.js");

    installFetchMock(async (url) => {
      if (url.includes("/api/tags")) {
        return makeTagsResponse(["llama3.2:latest"]);
      }
      if (url.includes("/api/generate")) {
        return new Response("internal server error", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await generateOllama(SAMPLE_INPUT, DEFAULT_OPTS);
    assert.equal(result, null, "should return null on HTTP 500");
  });

  test("non-JSON body from /api/generate returns null", async () => {
    const { generateOllama } = await import("../../learn/ollamaGenerator.js");

    installFetchMock(async (url) => {
      if (url.includes("/api/tags")) {
        return makeTagsResponse(["llama3.2:latest"]);
      }
      if (url.includes("/api/generate")) {
        return new Response("this is not json at all", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await generateOllama(SAMPLE_INPUT, DEFAULT_OPTS);
    assert.equal(result, null, "should return null on non-JSON body");
  });

  test("schema validation failure returns null", async () => {
    const { generateOllama } = await import("../../learn/ollamaGenerator.js");

    // Missing required fields (no keyPoints).
    const invalidSummary = { themes: ["A theme"] };

    installFetchMock(async (url) => {
      if (url.includes("/api/tags")) {
        return makeTagsResponse(["llama3.2:latest"]);
      }
      if (url.includes("/api/generate")) {
        return makeGenerateResponse(invalidSummary);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await generateOllama(SAMPLE_INPUT, DEFAULT_OPTS);
    assert.equal(result, null, "should return null when schema validation fails");
  });

  test("schema violation (empty themes array) returns null", async () => {
    const { generateOllama } = await import("../../learn/ollamaGenerator.js");

    // themes must have at least 1 item.
    const invalidSummary = {
      themes: [],
      keyPoints: ["A key point", "Another key point", "Third key point"],
      openQuestions: [],
    };

    installFetchMock(async (url) => {
      if (url.includes("/api/tags")) {
        return makeTagsResponse(["llama3.2:latest"]);
      }
      if (url.includes("/api/generate")) {
        return makeGenerateResponse(invalidSummary);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await generateOllama(SAMPLE_INPUT, DEFAULT_OPTS);
    assert.equal(result, null, "should return null when themes is empty (schema min 1)");
  });

  test("timeout (pre-aborted signal) returns null", async () => {
    const { generateOllama } = await import("../../learn/ollamaGenerator.js");

    installFetchMock(async (url, init) => {
      if (url.includes("/api/tags")) {
        return makeTagsResponse(["llama3.2:latest"]);
      }
      if (url.includes("/api/generate")) {
        // Simulate hanging by returning a promise that rejects with AbortError.
        const signal = init?.signal;
        return new Promise((_res, rej) => {
          if (signal?.aborted) {
            rej(new DOMException("The operation was aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => {
            rej(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      }
      return new Response("not found", { status: 404 });
    });

    // Pass a pre-aborted signal.
    const controller = new AbortController();
    controller.abort();

    const result = await generateOllama(SAMPLE_INPUT, {
      ...DEFAULT_OPTS,
      signal: controller.signal,
    });
    assert.equal(result, null, "should return null on aborted signal (timeout)");
  });

  test("malformed outer JSON (no 'response' field) returns null", async () => {
    const { generateOllama } = await import("../../learn/ollamaGenerator.js");

    installFetchMock(async (url) => {
      if (url.includes("/api/tags")) {
        return makeTagsResponse(["llama3.2:latest"]);
      }
      if (url.includes("/api/generate")) {
        // Valid JSON but missing the "response" field that Ollama normally provides.
        const body = JSON.stringify({ model: "llama3.2", done: true });
        return new Response(body, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await generateOllama(SAMPLE_INPUT, DEFAULT_OPTS);
    assert.equal(result, null, "should return null when 'response' field is missing");
  });

  test("empty response string from Ollama returns null", async () => {
    const { generateOllama } = await import("../../learn/ollamaGenerator.js");

    installFetchMock(async (url) => {
      if (url.includes("/api/tags")) {
        return makeTagsResponse(["llama3.2:latest"]);
      }
      if (url.includes("/api/generate")) {
        return makeGenerateResponseRaw("");
      }
      return new Response("not found", { status: 404 });
    });

    const result = await generateOllama(SAMPLE_INPUT, DEFAULT_OPTS);
    assert.equal(result, null, "should return null for empty response string");
  });

  test("prefix-match: 'llama3.2' matches 'llama3.2:3b' and returns the resolved tag", async () => {
    const { generateOllama } = await import("../../learn/ollamaGenerator.js");

    installFetchMock(async (url) => {
      if (url.includes("/api/tags")) {
        // Only "llama3.2:3b" is installed — not "llama3.2" exactly.
        return makeTagsResponse(["llama3.2:3b", "qwen2.5:3b"]);
      }
      if (url.includes("/api/generate")) {
        // Verify the request body uses the resolved tag.
        const body = JSON.stringify({ response: JSON.stringify(VALID_SUMMARY) });
        return new Response(body, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await generateOllama(SAMPLE_INPUT, {
      model: "llama3.2",
      baseUrl: "http://localhost:11434",
    });

    assert.ok(result !== null, "should succeed with prefix-matched model");
    // resolvedModel must be the exact installed tag, not the requested prefix.
    assert.equal(result.resolvedModel, "llama3.2:3b", "resolvedModel should be the exact tag");
    assert.deepEqual(result.summary.themes, VALID_SUMMARY.themes);
  });

  test("inner JSON parse failure (response is not JSON) returns null", async () => {
    const { generateOllama } = await import("../../learn/ollamaGenerator.js");

    installFetchMock(async (url) => {
      if (url.includes("/api/tags")) {
        return makeTagsResponse(["llama3.2:latest"]);
      }
      if (url.includes("/api/generate")) {
        // The response field is a non-JSON string (LLM produced prose).
        return makeGenerateResponseRaw("Sure, here are the themes: A, B, C. Key points: ...");
      }
      return new Response("not found", { status: 404 });
    });

    const result = await generateOllama(SAMPLE_INPUT, DEFAULT_OPTS);
    assert.equal(result, null, "should return null when response field is not parseable JSON");
  });
});
