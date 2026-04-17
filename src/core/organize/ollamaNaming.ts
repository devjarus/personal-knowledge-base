/**
 * ollamaNaming.ts — Ollama-backed folder naming for organize clusters.
 *
 * First tier in the folder-naming fallback chain:
 *   1. Ollama (if running locally at $KB_ORGANIZE_OLLAMA_URL, model configured)
 *   2. Flan-T5 via @huggingface/transformers (see llmNaming.ts)
 *   3. TF-IDF deriveFolderName (see folderName.ts)
 *
 * Why Ollama first: the names it produces ("react-performance",
 * "embedding-retrieval", "llm-evals") are dramatically better than Flan-T5's
 * 1-word outputs. But Ollama is optional — probe with a short timeout and
 * fall back silently when it's not available.
 *
 * Config:
 *   - KB_ORGANIZE_OLLAMA_URL   Ollama base URL (default http://localhost:11434)
 *   - KB_ORGANIZE_MODEL        Ollama model tag (default llama3.2:3b)
 *   - KB_ORGANIZE_NO_OLLAMA=1  Disable Ollama probe entirely
 *
 * All functions here are async and gracefully handle network failure by
 * throwing — the caller should catch and fall back to the next tier.
 */

import { slugify } from "./folderName";

// ---------------------------------------------------------------------------
// Public types (shared with llmNaming.ts)
// ---------------------------------------------------------------------------

export interface ClusterForNaming {
  memberTitles: string[];
  memberTags: string[];
  topTermsTfIdf: string[];
  memberCount: number;
}

export interface OllamaOptions {
  /** Base URL; default http://localhost:11434 (or $KB_ORGANIZE_OLLAMA_URL). */
  baseUrl?: string;
  /** Model tag; default llama3.2:3b (or $KB_ORGANIZE_MODEL). */
  model?: string;
  /** Probe timeout in ms; default 500. */
  probeTimeoutMs?: number;
  /** Per-cluster generation timeout in ms; default 15000. */
  generateTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Defaults + env resolution
// ---------------------------------------------------------------------------

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
// Bare tag (no colon) — prefix-matches against any installed variant
// ("llama3.2:3b", "llama3.2:latest", etc.) so users who already have *some*
// flavour of llama3.2 don't need to configure anything.
export const DEFAULT_OLLAMA_MODEL = "llama3.2";
const DEFAULT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_GENERATE_TIMEOUT_MS = 15_000;

/** Resolve Ollama config from options + environment variables. */
export function resolveOllamaConfig(opts: OllamaOptions = {}): Required<OllamaOptions> {
  return {
    baseUrl:
      opts.baseUrl ??
      process.env.KB_ORGANIZE_OLLAMA_URL ??
      DEFAULT_OLLAMA_URL,
    model:
      opts.model ??
      process.env.KB_ORGANIZE_MODEL ??
      DEFAULT_OLLAMA_MODEL,
    probeTimeoutMs: opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    generateTimeoutMs: opts.generateTimeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS,
  };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export interface ProbeResult {
  available: boolean;
  /** List of installed model tags (e.g. ["llama3.2:3b", "qwen2.5:3b"]). */
  models: string[];
}

/**
 * Probe Ollama at the configured URL. Returns `{available: false, models: []}`
 * on network failure, timeout, or non-200 response. Never throws.
 */
export async function probeOllama(
  baseUrl: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
      signal: controller.signal,
    });
    if (!res.ok) return { available: false, models: [] };
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models ?? [])
      .map((m) => m?.name ?? "")
      .filter((n) => n.length > 0);
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Does this model list contain the requested model tag? Accepts either an
 * exact match ("llama3.2:3b") or a prefix match before the colon
 * ("llama3.2" matches "llama3.2:3b", "llama3.2:latest").
 */
export function hasModel(available: string[], requested: string): boolean {
  if (available.includes(requested)) return true;
  if (!requested.includes(":")) {
    // Prefix match: user asked for "llama3.2", accept "llama3.2:3b" etc.
    const prefix = `${requested}:`;
    return available.some((m) => m.startsWith(prefix));
  }
  return false;
}

/**
 * Pick the best match from the available models for the requested model tag.
 * Returns the exact requested tag if present, otherwise the first prefix match
 * (for cases like user asked "llama3.2" and only "llama3.2:3b" is installed).
 */
export function resolveModel(available: string[], requested: string): string | null {
  if (available.includes(requested)) return requested;
  if (!requested.includes(":")) {
    const prefix = `${requested}:`;
    const match = available.find((m) => m.startsWith(prefix));
    if (match) return match;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

/**
 * Build the naming prompt for a single cluster. Short, explicit, and asks
 * for kebab-case output so post-processing is minimal.
 */
export function buildPrompt(c: ClusterForNaming): string {
  const titles = c.memberTitles.slice(0, 12).join(", ");
  const tags = c.memberTags.slice(0, 10).join(", ");
  const tagsLine = tags ? `\nTags: ${tags}` : "";
  return (
    `You are naming a folder that will contain the notes listed below.\n` +
    `Respond with ONLY a 1-3 word folder name in kebab-case. ` +
    `No quotes, no punctuation, no explanation.\n\n` +
    `Notes: ${titles}${tagsLine}\n\n` +
    `Folder name:`
  );
}

/**
 * Call Ollama's /api/generate with a single prompt, returning the raw text.
 * Throws on timeout or non-200 so the caller can fall back.
 */
export async function generateWithOllama(
  baseUrl: string,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          num_predict: 20,
          temperature: 0,
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as { response?: string };
    return data.response ?? "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the folder-name candidate from a raw Ollama response. The model
 * may wrap its answer in quotes, prefix it with "Folder name:", or emit a
 * short explanation — be defensive.
 */
export function extractName(raw: string): string {
  let text = raw.trim();
  // Strip common prefixes.
  text = text.replace(/^(folder name|answer|name)\s*:\s*/i, "");
  // Take the first line only.
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  // Strip surrounding quotes / backticks.
  const unquoted = firstLine.replace(/^["'`]+|["'`]+$/g, "");
  return slugify(unquoted);
}

// ---------------------------------------------------------------------------
// Orchestration: name all clusters via Ollama
// ---------------------------------------------------------------------------

/**
 * Try to name every cluster via Ollama. Probes first; if unavailable or the
 * configured model isn't installed, throws `OllamaUnavailableError` so the
 * caller can fall back to Flan-T5. Per-cluster generation failures produce
 * an empty-string slot — the caller is expected to backfill those from
 * TF-IDF (so a single transient error doesn't poison the whole run).
 *
 * @returns array aligned with `clusters`; entries may be empty strings if
 *          that specific cluster's generation failed. Caller must backfill.
 */
export async function tryOllamaNaming(
  clusters: ClusterForNaming[],
  opts: OllamaOptions = {},
): Promise<string[]> {
  const cfg = resolveOllamaConfig(opts);

  // 1. Probe.
  const probe = await probeOllama(cfg.baseUrl, cfg.probeTimeoutMs);
  if (!probe.available) {
    throw new OllamaUnavailableError(
      `Ollama not reachable at ${cfg.baseUrl} (is it running?)`,
    );
  }

  // 2. Resolve model tag.
  const resolved = resolveModel(probe.models, cfg.model);
  if (resolved === null) {
    throw new OllamaUnavailableError(
      `Ollama model "${cfg.model}" not installed. ` +
        `Available: [${probe.models.join(", ") || "none"}]. ` +
        `Try \`ollama pull ${cfg.model}\`.`,
    );
  }

  // 3. Generate per cluster, tolerating per-cluster failures.
  const names: string[] = [];
  for (const c of clusters) {
    try {
      const raw = await generateWithOllama(
        cfg.baseUrl,
        resolved,
        buildPrompt(c),
        cfg.generateTimeoutMs,
      );
      const slug = extractName(raw);
      names.push(slug);
    } catch {
      // Per-cluster failure — emit empty, caller will backfill from TF-IDF.
      names.push("");
    }
  }

  return names;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when Ollama probe fails or the requested model isn't installed. */
export class OllamaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Convenience: is Ollama disabled via env?
// ---------------------------------------------------------------------------

/** True if KB_ORGANIZE_NO_OLLAMA is set (any truthy value). */
export function ollamaDisabledByEnv(): boolean {
  const v = process.env.KB_ORGANIZE_NO_OLLAMA;
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}
