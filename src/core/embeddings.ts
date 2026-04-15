/**
 * embeddings.ts — thin wrapper around @huggingface/transformers pipeline.
 *
 * Singleton, lazy-loaded, never throws to callers — they must wrap in try/catch.
 * Uses Xenova/all-MiniLM-L6-v2: 384-dim, quantized ONNX (~23MB), English-first.
 *
 * Dependency direction: this module has NO imports from src/core/*.
 * All other core modules may import from this file freely.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — @huggingface/transformers has ESM-only exports; bundler mode handles it
import { pipeline, env } from "@huggingface/transformers";

// Let transformers.js use its default cache ($XDG_CACHE_HOME/huggingface/).
// We do NOT set env.cacheDir — no global env mutation per spec FR-1.
// Disable WASM proxy — we run in Node with the native ONNX runtime.
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
(env as { backends: { onnx: { wasm: { proxy: boolean } } } }).backends.onnx.wasm.proxy = false;

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

// Module-scoped pipeline promise. Null until first load attempt.
// On rejection we reset to null so a retry is possible on the next call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipelinePromise: Promise<any> | null = null;
let _warm = false;

/** Has the pipeline been successfully loaded at least once this process? */
export function isEmbedderWarm(): boolean {
  return _warm;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadPipeline(): Promise<any> {
  if (_pipelinePromise) return _pipelinePromise;

  const t0 = Date.now();
  process.stderr.write(`[embeddings] loading model ${EMBEDDING_MODEL}…\n`);

  _pipelinePromise = (pipeline as (
    task: string,
    model: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: Record<string, unknown>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<any>)("feature-extraction", EMBEDDING_MODEL, {
    dtype: "q8",  // quantized — keeps weights ~23MB
    device: "cpu",
  }).then((p) => {
    _warm = true;
    const elapsed = Date.now() - t0;
    process.stderr.write(`[embeddings] model ready (${elapsed}ms)\n`);
    return p;
  }).catch((err: unknown) => {
    // Reset so the next call can retry.
    _pipelinePromise = null;
    process.stderr.write(
      `[embeddings] failed to load model: ${err instanceof Error ? err.message : String(err)}\n`
    );
    throw err;
  });

  return _pipelinePromise;
}

/**
 * Warm up the pipeline. Safe to call multiple times — resolves once the model
 * is ready. Subsequent calls are no-ops returning immediately.
 */
export async function warmUpEmbedder(): Promise<void> {
  await loadPipeline();
}

/**
 * Embed a single string → 384-dim Float32Array.
 *
 * Uses mean pooling + normalize=true so cosine similarity == dot product.
 * Truncates input to the model's 512-token limit automatically (FR-1).
 *
 * Throws if the model fails to load; callers MUST wrap in try/catch.
 * Privacy: input text is never logged.
 */
export async function embedText(text: string): Promise<Float32Array> {
  const extractor = await loadPipeline();
  // truncation: true lets the tokenizer handle 512-token limit (FR-1 note).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const result = await extractor(text, {
    pooling: "mean",
    normalize: true,
    truncation: true,
  });
  // transformers.js returns a Tensor; .data is a Float32Array
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return result.data as Float32Array;
}

/**
 * Internal: reset the pipeline for testing.
 * Not exported in the public API surface — only for test injection.
 */
export function _resetEmbedder(): void {
  _pipelinePromise = null;
  _warm = false;
}
