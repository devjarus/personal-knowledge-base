/**
 * ollamaGenerator.ts — Ollama-backed summary generator for the learn pipeline.
 *
 * Calls POST /api/generate with format: "json" and validates the response
 * against `generatedSummarySchema`. Returns null on any failure so the caller
 * can fall back to the extractive tier — never throws.
 *
 * Reuses `probeOllama`, `resolveModel`, `resolveOllamaConfig` from
 * organize/ollamaNaming.ts rather than duplicating them.
 *
 * Config:
 *   - KB_LEARN_MODEL       Ollama model tag (default llama3.2)
 *   - KB_LEARN_OLLAMA_URL  Ollama base URL (default http://localhost:11434)
 *   - KB_LEARN_NO_OLLAMA   Disable Ollama entirely (any truthy value)
 */

import type { PromptInput, GeneratedSummary } from "./prompts";
import { buildPrompt, generatedSummarySchema } from "./prompts";
import {
  probeOllama,
  resolveModel,
} from "../organize/ollamaNaming";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OllamaGenOptions {
  /** Ollama model tag; default "llama3.2" (or KB_LEARN_MODEL). */
  model: string;
  /** Ollama base URL; default "http://localhost:11434" (or KB_LEARN_OLLAMA_URL). */
  baseUrl: string;
  /** Optional external AbortSignal. If omitted, a 30s internal timeout is used. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LEARN_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_LEARN_MODEL = "llama3.2";
/** Timeout for the generate call — summaries are longer than folder names. */
const GENERATE_TIMEOUT_MS = 30_000;
/** Probe timeout: same short window as organize to keep dry-runs fast. */
const PROBE_TIMEOUT_MS = 500;

// ---------------------------------------------------------------------------
// Config helpers (learn-pipeline-specific env vars)
// ---------------------------------------------------------------------------

/** Resolve the Ollama base URL for the learn pipeline. */
export function resolveLearnOllamaUrl(override?: string): string {
  return (
    override ??
    process.env.KB_LEARN_OLLAMA_URL ??
    DEFAULT_LEARN_OLLAMA_URL
  );
}

/** Resolve the Ollama model tag for the learn pipeline. */
export function resolveLearnModel(override?: string): string {
  return (
    override ??
    process.env.KB_LEARN_MODEL ??
    DEFAULT_LEARN_MODEL
  );
}

/** True if KB_LEARN_NO_OLLAMA is set to a truthy value. */
export function learnOllamaDisabledByEnv(): boolean {
  const v = process.env.KB_LEARN_NO_OLLAMA;
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

// ---------------------------------------------------------------------------
// Probe helper — re-exported for use in buildLearnPlan (Phase 3 wiring)
// ---------------------------------------------------------------------------

/**
 * Probe Ollama for learn pipeline purposes.
 * Returns { available, resolvedModel } — resolvedModel is null if the
 * requested model is not installed.
 *
 * Never throws.
 */
export async function probeLearnOllama(
  baseUrl: string,
  requestedModel: string
): Promise<{ available: boolean; resolvedModel: string | null; error?: string }> {
  const probe = await probeOllama(baseUrl, PROBE_TIMEOUT_MS);
  if (!probe.available) {
    return {
      available: false,
      resolvedModel: null,
      error: `Ollama not reachable at ${baseUrl} (is it running?)`,
    };
  }

  const resolved = resolveModel(probe.models, requestedModel);
  if (resolved === null) {
    return {
      available: true,
      resolvedModel: null,
      error:
        `Ollama model "${requestedModel}" not installed. ` +
        `Available: [${probe.models.join(", ") || "none"}]. ` +
        `Try \`ollama pull ${requestedModel}\`.`,
    };
  }

  return { available: true, resolvedModel: resolved };
}

// ---------------------------------------------------------------------------
// Core generator
// ---------------------------------------------------------------------------

/**
 * Generate a structured summary for a cluster via Ollama's /api/generate.
 *
 * Returns null on any failure:
 *  - Ollama probe failed (unreachable or model not installed)
 *  - HTTP non-200 response
 *  - Network error or timeout
 *  - Response body is not valid JSON
 *  - JSON doesn't match generatedSummarySchema
 *
 * Never throws — caller falls back to extractive tier.
 *
 * The actual resolved model name is returned alongside the summary so the
 * caller can record it accurately in the ledger (fixes F7 latent bug).
 */
export async function generateOllama(
  input: PromptInput,
  opts: OllamaGenOptions
): Promise<{ summary: GeneratedSummary; resolvedModel: string } | null> {
  const { baseUrl, signal: externalSignal } = opts;
  const requestedModel = opts.model;

  // 1. Probe Ollama and resolve the model tag.
  const probe = await probeLearnOllama(baseUrl, requestedModel);
  if (!probe.available || probe.resolvedModel === null) {
    if (process.env.KB_DEBUG === "1") {
      process.stderr.write(
        `[learn/ollama] probe failed: ${probe.error ?? "unknown"}\n`
      );
    }
    return null;
  }

  const resolvedModel = probe.resolvedModel;

  // 2. Build the prompt.
  const { system, user } = buildPrompt(input);
  // Ollama's /api/generate takes a single `prompt` field.
  const prompt = `${system}\n\n${user}`;

  // 3. Set up abort controller with 30s timeout, chaining external signal if provided.
  // LOAD-BEARING: 30s timeout — summaries need more time than folder names (15s).
  let internalController: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let signal: AbortSignal;

  if (externalSignal) {
    // Use caller-provided signal directly (tests can pass a pre-aborted signal).
    signal = externalSignal;
  } else {
    internalController = new AbortController();
    timer = setTimeout(() => internalController!.abort(), GENERATE_TIMEOUT_MS);
    signal = internalController.signal;
  }

  try {
    const url = `${baseUrl.replace(/\/$/, "")}/api/generate`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: resolvedModel,
          prompt,
          stream: false,
          format: "json",
          options: { temperature: 0.2 },
        }),
        signal,
      });
    } catch (err) {
      // Network error, timeout (AbortError), or connection refused.
      if (process.env.KB_DEBUG === "1") {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[learn/ollama] fetch error: ${msg}\n`);
      }
      return null;
    }

    // 4. Check HTTP status.
    if (!res.ok) {
      if (process.env.KB_DEBUG === "1") {
        process.stderr.write(
          `[learn/ollama] HTTP ${res.status} from ${url}\n`
        );
      }
      return null;
    }

    // 5. Parse response body.
    let rawBody: string;
    try {
      rawBody = await res.text();
    } catch (err) {
      if (process.env.KB_DEBUG === "1") {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[learn/ollama] body read error: ${msg}\n`);
      }
      return null;
    }

    // Ollama wraps the JSON response in a `response` field.
    let ollamaPayload: unknown;
    try {
      ollamaPayload = JSON.parse(rawBody);
    } catch {
      if (process.env.KB_DEBUG === "1") {
        process.stderr.write(
          `[learn/ollama] outer JSON parse failed. Raw: ${rawBody.slice(0, 200)}\n`
        );
      }
      return null;
    }

    // Extract the `response` field which contains the JSON the model generated.
    const responseField =
      ollamaPayload != null &&
      typeof ollamaPayload === "object" &&
      "response" in ollamaPayload
        ? (ollamaPayload as Record<string, unknown>).response
        : null;

    if (typeof responseField !== "string") {
      if (process.env.KB_DEBUG === "1") {
        process.stderr.write(
          `[learn/ollama] response field missing or not a string\n`
        );
      }
      return null;
    }

    // 6. Parse the model-generated JSON.
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(responseField);
    } catch {
      if (process.env.KB_DEBUG === "1") {
        process.stderr.write(
          `[learn/ollama] inner JSON parse failed. Response: ${responseField.slice(0, 200)}\n`
        );
      }
      return null;
    }

    // 7. Validate with zod.
    const validated = generatedSummarySchema.safeParse(parsedJson);
    if (!validated.success) {
      if (process.env.KB_DEBUG === "1") {
        process.stderr.write(
          `[learn/ollama] schema validation failed: ${validated.error.message}\n`
        );
      }
      return null;
    }

    return { summary: validated.data, resolvedModel };
  } finally {
    // Always clear the internal timer to avoid resource leaks.
    if (timer !== null) clearTimeout(timer);
  }
}
