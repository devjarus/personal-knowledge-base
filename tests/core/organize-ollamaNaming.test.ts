/**
 * Tests for organize/ollamaNaming.ts — probe, generate, fallback chain.
 *
 * All tests use mocked global.fetch so they don't require a running Ollama
 * instance. This file exercises the probe/generate primitives in isolation,
 * plus the full `nameClusters` fallback chain with Ollama either present or
 * absent.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  probeOllama,
  hasModel,
  resolveModel,
  buildPrompt,
  extractName,
  tryOllamaNaming,
  OllamaUnavailableError,
  resolveOllamaConfig,
  ollamaDisabledByEnv,
  DEFAULT_OLLAMA_URL,
  DEFAULT_OLLAMA_MODEL,
} from "@/core/organize/ollamaNaming.js";
import type { ClusterForNaming } from "@/core/organize/ollamaNaming.js";

import { nameClusters } from "@/core/organize/llmNaming.js";

// ---------------------------------------------------------------------------
// Fetch mocking helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalFetch: any = globalThis.fetch;

interface MockResponse {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}

type FetchHandler = (url: string, init?: RequestInit) => Promise<MockResponse>;

function mockFetch(handler: FetchHandler): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    return handler(url, init);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCluster(opts: Partial<ClusterForNaming> = {}): ClusterForNaming {
  return {
    memberTitles: ["Note A", "Note B"],
    memberTags: ["tag1"],
    topTermsTfIdf: ["term1", "term2"],
    memberCount: 2,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// resolveOllamaConfig
// ---------------------------------------------------------------------------

describe("resolveOllamaConfig", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  test("uses defaults when no opts or env", () => {
    delete process.env.KB_ORGANIZE_MODEL;
    delete process.env.KB_ORGANIZE_OLLAMA_URL;
    const cfg = resolveOllamaConfig();
    assert.equal(cfg.baseUrl, DEFAULT_OLLAMA_URL);
    assert.equal(cfg.model, DEFAULT_OLLAMA_MODEL);
    // Default model is bare (no colon) so it prefix-matches any installed variant.
    assert.equal(cfg.model.includes(":"), false);
    assert.equal(cfg.probeTimeoutMs, 500);
    assert.equal(cfg.generateTimeoutMs, 15_000);
  });

  test("reads env vars when no opts", () => {
    process.env.KB_ORGANIZE_MODEL = "qwen2.5:3b";
    process.env.KB_ORGANIZE_OLLAMA_URL = "http://other:9999";
    const cfg = resolveOllamaConfig();
    assert.equal(cfg.baseUrl, "http://other:9999");
    assert.equal(cfg.model, "qwen2.5:3b");
  });

  test("opts override env vars", () => {
    process.env.KB_ORGANIZE_MODEL = "env-model";
    process.env.KB_ORGANIZE_OLLAMA_URL = "http://env-host:1";
    const cfg = resolveOllamaConfig({
      baseUrl: "http://opts-host:2",
      model: "opts-model",
    });
    assert.equal(cfg.baseUrl, "http://opts-host:2");
    assert.equal(cfg.model, "opts-model");
  });
});

describe("ollamaDisabledByEnv", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  test("false when unset", () => {
    delete process.env.KB_ORGANIZE_NO_OLLAMA;
    assert.equal(ollamaDisabledByEnv(), false);
  });

  test("false when set to empty / 0 / false", () => {
    process.env.KB_ORGANIZE_NO_OLLAMA = "";
    assert.equal(ollamaDisabledByEnv(), false);
    process.env.KB_ORGANIZE_NO_OLLAMA = "0";
    assert.equal(ollamaDisabledByEnv(), false);
    process.env.KB_ORGANIZE_NO_OLLAMA = "false";
    assert.equal(ollamaDisabledByEnv(), false);
    process.env.KB_ORGANIZE_NO_OLLAMA = "False";
    assert.equal(ollamaDisabledByEnv(), false);
  });

  test("true when set to 1 / true / anything else", () => {
    process.env.KB_ORGANIZE_NO_OLLAMA = "1";
    assert.equal(ollamaDisabledByEnv(), true);
    process.env.KB_ORGANIZE_NO_OLLAMA = "true";
    assert.equal(ollamaDisabledByEnv(), true);
    process.env.KB_ORGANIZE_NO_OLLAMA = "yes";
    assert.equal(ollamaDisabledByEnv(), true);
  });
});

// ---------------------------------------------------------------------------
// hasModel / resolveModel
// ---------------------------------------------------------------------------

describe("hasModel", () => {
  test("exact match wins", () => {
    assert.equal(hasModel(["llama3.2:3b", "qwen2.5:3b"], "llama3.2:3b"), true);
  });

  test("prefix match when requested has no colon", () => {
    assert.equal(hasModel(["llama3.2:3b"], "llama3.2"), true);
    assert.equal(hasModel(["llama3.2:latest"], "llama3.2"), true);
  });

  test("no prefix match when requested has a colon", () => {
    // If user explicitly asks "llama3.2:7b", a "llama3.2:3b" should NOT match.
    assert.equal(hasModel(["llama3.2:3b"], "llama3.2:7b"), false);
  });

  test("returns false when missing", () => {
    assert.equal(hasModel(["llama3.2:3b"], "qwen2.5:3b"), false);
    assert.equal(hasModel([], "llama3.2:3b"), false);
  });
});

describe("resolveModel", () => {
  test("returns exact match", () => {
    assert.equal(
      resolveModel(["llama3.2:3b", "qwen2.5:3b"], "llama3.2:3b"),
      "llama3.2:3b",
    );
  });

  test("returns prefix match", () => {
    assert.equal(resolveModel(["llama3.2:3b"], "llama3.2"), "llama3.2:3b");
  });

  test("returns null when missing", () => {
    assert.equal(resolveModel(["qwen2.5:3b"], "llama3.2:3b"), null);
  });
});

// ---------------------------------------------------------------------------
// probeOllama
// ---------------------------------------------------------------------------

describe("probeOllama", () => {
  afterEach(() => restoreFetch());

  test("returns available + models on 200", async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [{ name: "llama3.2:3b" }, { name: "qwen2.5:3b" }],
      }),
    }));

    const probe = await probeOllama("http://localhost:11434", 500);
    assert.equal(probe.available, true);
    assert.deepEqual(probe.models, ["llama3.2:3b", "qwen2.5:3b"]);
  });

  test("returns unavailable on non-200", async () => {
    mockFetch(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));

    const probe = await probeOllama("http://localhost:11434", 500);
    assert.equal(probe.available, false);
    assert.deepEqual(probe.models, []);
  });

  test("returns unavailable on fetch throw (ECONNREFUSED / timeout)", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    const probe = await probeOllama("http://localhost:11434", 500);
    assert.equal(probe.available, false);
    assert.deepEqual(probe.models, []);
  });

  test("hits /api/tags at the given base URL (strips trailing slash)", async () => {
    let capturedUrl = "";
    mockFetch(async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [] }),
      };
    });

    await probeOllama("http://example.com:1234/", 500);
    assert.equal(capturedUrl, "http://example.com:1234/api/tags");
  });
});

// ---------------------------------------------------------------------------
// buildPrompt / extractName
// ---------------------------------------------------------------------------

describe("buildPrompt", () => {
  test("includes titles and tags", () => {
    const p = buildPrompt(
      makeCluster({
        memberTitles: ["React hooks", "useEffect gotchas"],
        memberTags: ["react", "hooks"],
      }),
    );
    assert.ok(p.includes("React hooks"));
    assert.ok(p.includes("useEffect gotchas"));
    assert.ok(p.includes("react, hooks"));
    assert.ok(p.toLowerCase().includes("folder name"));
  });

  test("omits tags line when empty", () => {
    const p = buildPrompt(makeCluster({ memberTags: [] }));
    assert.ok(!p.includes("Tags:"));
  });

  test("truncates long title and tag lists", () => {
    const manyTitles = Array.from({ length: 50 }, (_, i) => `title-${i}`);
    const p = buildPrompt(makeCluster({ memberTitles: manyTitles }));
    // First 12 should be there, 13th should not.
    assert.ok(p.includes("title-0"));
    assert.ok(p.includes("title-11"));
    assert.ok(!p.includes("title-12"));
  });
});

describe("extractName", () => {
  test("slugifies simple answer", () => {
    assert.equal(extractName("React Performance"), "react-performance");
  });

  test("strips 'Folder name:' prefix", () => {
    assert.equal(extractName("Folder name: react-performance"), "react-performance");
    assert.equal(extractName("folder name: React Performance"), "react-performance");
  });

  test("strips 'Answer:' prefix", () => {
    assert.equal(extractName("Answer: llm-evals"), "llm-evals");
  });

  test("strips surrounding quotes and backticks", () => {
    assert.equal(extractName('"react-performance"'), "react-performance");
    assert.equal(extractName("'react-performance'"), "react-performance");
    assert.equal(extractName("`react-performance`"), "react-performance");
  });

  test("takes only the first line of a multi-line response", () => {
    assert.equal(
      extractName("react-performance\n\nThese notes cover React hooks and..."),
      "react-performance",
    );
  });

  test("handles already-slug-safe input", () => {
    assert.equal(extractName("llm-evals"), "llm-evals");
  });

  test("returns empty string for empty input", () => {
    assert.equal(extractName(""), "");
    assert.equal(extractName("   "), "");
  });
});

// ---------------------------------------------------------------------------
// tryOllamaNaming — full orchestration, mocked
// ---------------------------------------------------------------------------

describe("tryOllamaNaming", () => {
  afterEach(() => restoreFetch());

  test("throws OllamaUnavailableError when probe fails", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    await assert.rejects(
      () => tryOllamaNaming([makeCluster()], { model: "llama3.2:3b" }),
      OllamaUnavailableError,
    );
  });

  test("throws OllamaUnavailableError when model missing", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: "qwen2.5:3b" }] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ response: "" }) };
    });

    await assert.rejects(
      () => tryOllamaNaming([makeCluster()], { model: "llama3.2:3b" }),
      OllamaUnavailableError,
    );
  });

  test("returns names when Ollama is reachable", async () => {
    let callCount = 0;
    mockFetch(async (url) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: "llama3.2:3b" }] }),
        };
      }
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: `cluster-${callCount}` }),
      };
    });

    const clusters = [makeCluster(), makeCluster(), makeCluster()];
    const names = await tryOllamaNaming(clusters, { model: "llama3.2:3b" });
    assert.equal(names.length, 3);
    for (const n of names) {
      assert.match(n, /^[a-z0-9][a-z0-9-]*$/, `"${n}" is not slug-safe`);
    }
  });

  test("emits empty string for per-cluster failures", async () => {
    let callCount = 0;
    mockFetch(async (url) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: "llama3.2:3b" }] }),
        };
      }
      callCount++;
      // First generate succeeds, second throws, third succeeds.
      if (callCount === 2) throw new Error("boom");
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: `name-${callCount}` }),
      };
    });

    const clusters = [makeCluster(), makeCluster(), makeCluster()];
    const names = await tryOllamaNaming(clusters, { model: "llama3.2:3b" });
    assert.equal(names.length, 3);
    assert.ok(names[0].length > 0, "first name should be present");
    assert.equal(names[1], "", "middle name should be empty (per-cluster failure)");
    assert.ok(names[2].length > 0, "third name should be present");
  });

  test("accepts prefix-matched model", async () => {
    let probedUrl = "";
    let generatedModel = "";
    mockFetch(async (url, init) => {
      if (url.endsWith("/api/tags")) {
        probedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: "llama3.2:3b" }] }),
        };
      }
      // Record the model that was used in the generate call.
      const body = init?.body ? JSON.parse(init.body as string) : {};
      generatedModel = body.model;
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: "name" }),
      };
    });

    const names = await tryOllamaNaming([makeCluster()], { model: "llama3.2" });
    assert.equal(names.length, 1);
    assert.equal(
      generatedModel,
      "llama3.2:3b",
      "should resolve bare prefix to the installed tag",
    );
    assert.ok(probedUrl.endsWith("/api/tags"));
  });
});

// ---------------------------------------------------------------------------
// nameClusters — full fallback chain with fetch mocked
// ---------------------------------------------------------------------------

describe("nameClusters — fallback chain", () => {
  let savedNoOllama: string | undefined;

  beforeEach(() => {
    savedNoOllama = process.env.KB_ORGANIZE_NO_OLLAMA;
  });

  afterEach(() => {
    restoreFetch();
    if (savedNoOllama === undefined) {
      delete process.env.KB_ORGANIZE_NO_OLLAMA;
    } else {
      process.env.KB_ORGANIZE_NO_OLLAMA = savedNoOllama;
    }
  });

  test("uses Ollama when reachable and model present", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: "llama3.2:3b" }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: "react-performance" }),
      };
    });

    const clusters = [
      { memberTitles: ["React"], memberTags: [], topTermsTfIdf: ["react"], memberCount: 1 },
      { memberTitles: ["Vue"], memberTags: [], topTermsTfIdf: ["vue"], memberCount: 1 },
    ];
    const names = await nameClusters(clusters, new Set(), {
      ollamaModel: "llama3.2:3b",
    });

    assert.equal(names.length, 2);
    // With every generate returning the same name, dedup should still produce uniques.
    assert.equal(new Set(names).size, 2);
    for (const n of names) {
      assert.match(n, /^[a-z0-9][a-z0-9-]*$/);
    }
  });

  test("falls through to TF-IDF when noLlm is set (no fetch calls)", async () => {
    let fetchCalled = false;
    mockFetch(async () => {
      fetchCalled = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: "llama3.2:3b" }] }),
      };
    });

    const clusters = [
      {
        memberTitles: ["foo"],
        memberTags: [],
        topTermsTfIdf: ["typescript", "testing"],
        memberCount: 1,
      },
    ];
    const names = await nameClusters(clusters, new Set(), { noLlm: true });

    assert.equal(names.length, 1);
    assert.equal(fetchCalled, false, "noLlm should short-circuit BEFORE Ollama probe");
    assert.match(names[0], /^[a-z0-9][a-z0-9-]*$/);
  });

  test("falls through to TF-IDF when KB_ORGANIZE_NO_OLLAMA=1 and noLlm is also set", async () => {
    process.env.KB_ORGANIZE_NO_OLLAMA = "1";
    let fetchCalled = false;
    mockFetch(async () => {
      fetchCalled = true;
      return { ok: false, status: 500, json: async () => ({}) };
    });

    const clusters = [
      {
        memberTitles: ["foo"],
        memberTags: [],
        topTermsTfIdf: ["memory", "cache"],
        memberCount: 1,
      },
    ];
    const names = await nameClusters(clusters, new Set(), { noLlm: true });
    assert.equal(fetchCalled, false);
    assert.equal(names.length, 1);
  });

  test("noOllama option skips the probe entirely", async () => {
    let fetchCalled = false;
    mockFetch(async () => {
      fetchCalled = true;
      return { ok: false, status: 500, json: async () => ({}) };
    });

    // noLlm also set to avoid a Flan-T5 model load in this unit test.
    const clusters = [
      {
        memberTitles: ["foo"],
        memberTags: [],
        topTermsTfIdf: ["agents", "tools"],
        memberCount: 1,
      },
    ];
    const names = await nameClusters(clusters, new Set(), {
      noOllama: true,
      noLlm: true,
    });
    assert.equal(fetchCalled, false);
    assert.equal(names.length, 1);
  });

  test("dedupes Ollama output against existingFolders", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: "llama3.2:3b" }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: "agents" }),
      };
    });

    const existing = new Set(["agents"]);
    const names = await nameClusters(
      [
        {
          memberTitles: ["a"],
          memberTags: [],
          topTermsTfIdf: ["agents"],
          memberCount: 1,
        },
      ],
      existing,
      { ollamaModel: "llama3.2:3b" },
    );
    assert.equal(names.length, 1);
    assert.ok(!existing.has(names[0]), `"${names[0]}" should not collide with existing`);
  });
});
