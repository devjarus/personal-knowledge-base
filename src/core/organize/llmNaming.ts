/**
 * llmNaming.ts — LLM-assisted folder naming for organize clusters.
 *
 * Three-tier fallback chain:
 *   1. **Ollama** (if running locally, configurable via env or CLI flags) —
 *      produces the best names when available. Zero setup for users without
 *      Ollama; dramatically better output for users who have it installed.
 *   2. **Flan-T5-small** via @huggingface/transformers — fully local,
 *      ~80MB one-time download, no API key. Names tend to be 1 word.
 *   3. **TF-IDF deriveFolderName** — always works, uses top cluster terms.
 *
 * Callers pass `opts.noOllama` or `opts.noLlm` to skip tiers. The chain
 * always terminates at TF-IDF, so `nameClusters` never throws.
 *
 * Config (in addition to opts):
 *   - $KB_ORGANIZE_MODEL       Ollama model tag (default llama3.2:3b)
 *   - $KB_ORGANIZE_OLLAMA_URL  Ollama URL (default http://localhost:11434)
 *   - $KB_ORGANIZE_NO_OLLAMA   Disable Ollama entirely
 */

import { deriveFolderName, slugify } from "./folderName";
import {
  ollamaDisabledByEnv,
  OllamaUnavailableError,
  tryOllamaNaming,
} from "./ollamaNaming";
import type { ClusterForNaming as _ClusterForNaming } from "./ollamaNaming";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — @huggingface/transformers has ESM-only exports; bundler mode handles it
import { pipeline, env } from "@huggingface/transformers";

// Reuse the same WASM proxy setting as embeddings.ts.
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
(env as { backends: { onnx: { wasm: { proxy: boolean } } } }).backends.onnx.wasm.proxy = false;

const LOCAL_MODEL = "Xenova/flan-t5-small";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClusterForNaming {
  memberTitles: string[];   // note titles (member notes of this cluster)
  memberTags: string[];     // union of all tags across member notes
  topTermsTfIdf: string[];  // TF-IDF top terms — fallback context
  memberCount: number;
}

// Re-assert that our local type matches the shared one in ollamaNaming.ts.
// (Type-level assertion; no runtime cost.)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _TypeCheck = _ClusterForNaming extends ClusterForNaming
  ? ClusterForNaming extends _ClusterForNaming
    ? true
    : never
  : never;

export interface NameClustersOptions {
  /** Skip the Ollama tier entirely (fall through to Flan-T5 or TF-IDF). */
  noOllama?: boolean;
  /** Skip all LLM tiers (use TF-IDF only). Wins over `noOllama`. */
  noLlm?: boolean;
  /** Override Ollama model tag (else $KB_ORGANIZE_MODEL or llama3.2:3b). */
  ollamaModel?: string;
  /** Override Ollama base URL (else $KB_ORGANIZE_OLLAMA_URL or localhost:11434). */
  ollamaUrl?: string;
}

// ---------------------------------------------------------------------------
// Module-scoped pipeline (lazy, singleton — same pattern as embeddings.ts)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _genPipeline: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadGenerator(): Promise<any> {
  if (_genPipeline) return _genPipeline;

  _genPipeline = (pipeline as (
    task: string,
    model: string,
    opts: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<any>)("text2text-generation", LOCAL_MODEL, {
    dtype: "q8",
    device: "cpu",
  }).catch((err: unknown) => {
    _genPipeline = null;
    throw err;
  });

  return _genPipeline;
}

/** Reset for testing. */
export function _resetGenerator(): void {
  _genPipeline = null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function debugLog(msg: string): void {
  if (process.env.KB_DEBUG) process.stderr.write(msg);
}

/** Slugify and validate a candidate folder name. */
function toSafeSlug(name: string): string {
  return slugify(name);
}

/**
 * Assign unique names from a candidate list against an already-used set.
 * Empty-string candidates are treated as "fill from fallback" — this lets us
 * feed partial-result arrays (some names from Ollama, some blanks) through a
 * single deduplication pass with TF-IDF backfill.
 */
function deduplicateNames(
  candidates: string[],
  tfIdfFallbacks: string[],
  existingFolders: Set<string>,
): string[] {
  const used = new Set<string>(existingFolders);
  return candidates.map((candidate, i) => {
    // Empty candidate → use TF-IDF fallback for this slot.
    const seed = candidate.length > 0 ? candidate : tfIdfFallbacks[i] ?? "cluster";
    if (!used.has(seed)) {
      used.add(seed);
      return seed;
    }
    for (let n = 2; n < 1000; n++) {
      const suffixed = `${seed}-${n}`;
      if (!used.has(suffixed)) {
        used.add(suffixed);
        return suffixed;
      }
    }
    return `${seed}-overflow`;
  });
}

/**
 * Build a prompt for Flan-T5-small for a SINGLE cluster.
 * Flan-T5-small works best with short, direct prompts — one cluster at a time.
 */
function buildFlanT5Prompt(c: ClusterForNaming): string {
  const titles = c.memberTitles.slice(0, 10).join(", ");
  const tags = c.memberTags.slice(0, 8).join(", ");
  return (
    `What is the main topic of these notes? Answer with 1-3 words only.\n` +
    `Notes: ${titles}` +
    (tags ? `\nTags: ${tags}` : "")
  );
}

/** Compute TF-IDF fallback names for every cluster. */
function tfIdfNames(clusters: ClusterForNaming[]): string[] {
  return clusters.map((c) =>
    // Pre-slugify the TF-IDF top terms so the backfill path produces
    // consistent output with the LLM-name slugify path.
    // deriveFolderName takes an empty Set because collisions are handled
    // centrally in deduplicateNames.
    deriveFolderName(
      c.topTermsTfIdf.length > 0 ? c.topTermsTfIdf : ["cluster"],
      new Set(),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tier 2: Flan-T5 naming
// ---------------------------------------------------------------------------

async function tryFlanT5Naming(clusters: ClusterForNaming[]): Promise<string[]> {
  debugLog(`[organize] loading Flan-T5 (${LOCAL_MODEL})…\n`);
  const generator = await loadGenerator();
  debugLog(`[organize] Flan-T5 ready\n`);

  const names: string[] = [];
  for (const c of clusters) {
    try {
      const prompt = buildFlanT5Prompt(c);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const result = await generator(prompt, {
        max_new_tokens: 10,
        do_sample: false, // greedy = deterministic
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const raw = (result as Array<{ generated_text: string }>)[0]
        ?.generated_text ?? "";
      names.push(toSafeSlug(raw.trim()));
    } catch {
      names.push(""); // per-cluster failure → TF-IDF backfill in dedup pass
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Public: nameClusters
// ---------------------------------------------------------------------------

/**
 * Name clusters using the fallback chain: Ollama → Flan-T5 → TF-IDF.
 *
 * @param clusters        Cluster descriptors for naming.
 * @param existingFolders Already-used folder names (for collision avoidance).
 * @param opts            Optional. If omitted, uses env vars + auto-detect.
 * @returns               Array of folder name strings, one per cluster.
 */
export async function nameClusters(
  clusters: ClusterForNaming[],
  existingFolders: Set<string>,
  opts: NameClustersOptions = {},
): Promise<string[]> {
  if (clusters.length === 0) return [];

  const tfIdfFallbacks = tfIdfNames(clusters);

  // --- Tier 0: skip everything if `noLlm` ---
  if (opts.noLlm) {
    return deduplicateNames(
      Array(clusters.length).fill(""),
      tfIdfFallbacks,
      existingFolders,
    );
  }

  // --- Tier 1: Ollama ---
  const skipOllama = opts.noOllama || ollamaDisabledByEnv();
  if (!skipOllama) {
    try {
      debugLog(`[organize] probing Ollama…\n`);
      const ollamaNames = await tryOllamaNaming(clusters, {
        baseUrl: opts.ollamaUrl,
        model: opts.ollamaModel,
      });
      debugLog(`[organize] Ollama produced names for ${ollamaNames.filter((n) => n.length > 0).length}/${clusters.length} clusters\n`);
      return deduplicateNames(ollamaNames, tfIdfFallbacks, existingFolders);
    } catch (err) {
      if (err instanceof OllamaUnavailableError) {
        debugLog(`[organize] Ollama unavailable: ${err.message} — falling back to Flan-T5\n`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[organize] Ollama failed (${msg}) — falling back to Flan-T5\n`,
        );
      }
      // Fall through to Flan-T5.
    }
  }

  // --- Tier 2: Flan-T5 ---
  try {
    const flanNames = await tryFlanT5Naming(clusters);
    return deduplicateNames(flanNames, tfIdfFallbacks, existingFolders);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[organize] Flan-T5 failed (${msg}) — falling back to TF-IDF\n`,
    );
  }

  // --- Tier 3: TF-IDF ---
  return deduplicateNames(
    Array(clusters.length).fill(""),
    tfIdfFallbacks,
    existingFolders,
  );
}
