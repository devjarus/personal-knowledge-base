/**
 * llmNaming.ts — LLM-assisted folder naming for organize clusters.
 *
 * Uses a LOCAL text-generation model (Xenova/flan-t5-small via
 * @huggingface/transformers — already a project dependency for embeddings).
 * No API key, no network, no cost. Runs fully offline.
 *
 * Falls back to TF-IDF deriveFolderName when:
 *   - The local model fails to load, or
 *   - The user passes `--no-llm`.
 *
 * Names each cluster with a short 1–3 word topical label by prompting the
 * model with member titles + tags. The model is ~80MB (quantized ONNX),
 * downloaded once to $XDG_CACHE_HOME/huggingface/ on first use.
 */

import { deriveFolderName, slugify } from "./folderName.js";

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

/**
 * Slugify and validate a candidate folder name.
 */
function toSafeSlug(name: string): string {
  return slugify(name);
}

/**
 * Assign unique names from a candidate list against an already-used set.
 */
function deduplicateNames(
  candidates: string[],
  existingFolders: Set<string>,
): string[] {
  const used = new Set<string>(existingFolders);
  return candidates.map((candidate) => {
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    for (let i = 2; i < 1000; i++) {
      const suffixed = `${candidate}-${i}`;
      if (!used.has(suffixed)) {
        used.add(suffixed);
        return suffixed;
      }
    }
    return `${candidate}-overflow`;
  });
}

/**
 * Build a prompt for the local model for a SINGLE cluster.
 * Flan-T5-small works best with short, direct prompts — one cluster at a time.
 */
function buildSingleClusterPrompt(c: ClusterForNaming): string {
  const titles = c.memberTitles.slice(0, 10).join(", ");
  const tags = c.memberTags.slice(0, 8).join(", ");
  return (
    `What is the main topic of these notes? Answer with 1-3 words only.\n` +
    `Notes: ${titles}` +
    (tags ? `\nTags: ${tags}` : "")
  );
}

// ---------------------------------------------------------------------------
// Public: nameClusters
// ---------------------------------------------------------------------------

/**
 * Name clusters using a local text-generation model (Flan-T5-small).
 * Falls back to TF-IDF deriveFolderName if the model fails to load.
 *
 * @param clusters        Cluster descriptors for naming.
 * @param existingFolders Already-used folder names (for collision avoidance).
 * @returns               Array of folder name strings, one per cluster.
 */
export async function nameClusters(
  clusters: ClusterForNaming[],
  existingFolders: Set<string>,
): Promise<string[]> {
  if (clusters.length === 0) return [];

  // --- Local model path ---
  try {
    debugLog(`[organize] loading naming model ${LOCAL_MODEL}…\n`);
    const generator = await loadGenerator();
    debugLog(`[organize] naming model ready\n`);

    const names: string[] = [];
    for (const c of clusters) {
      const prompt = buildSingleClusterPrompt(c);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const result = await generator(prompt, {
        max_new_tokens: 10,
        // Flan-T5 doesn't support temperature=0 in some runtimes;
        // use do_sample=false for greedy decoding (deterministic).
        do_sample: false,
      });

      // Result shape: [{ generated_text: string }]
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const raw = (result as Array<{ generated_text: string }>)[0]
        ?.generated_text ?? "";
      const slug = toSafeSlug(raw.trim());

      if (slug.length > 0) {
        names.push(slug);
      } else {
        // Model output was empty or un-slugifiable → TF-IDF fallback for this cluster.
        names.push(
          deriveFolderName(
            c.topTermsTfIdf.length > 0 ? c.topTermsTfIdf : ["cluster"],
            new Set(),
          ),
        );
      }
    }

    return deduplicateNames(names, existingFolders);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[organize] local naming model failed (${msg}) — falling back to TF-IDF\n`,
    );
  }

  // --- TF-IDF fallback path ---
  const used = new Set<string>(existingFolders);
  return clusters.map((c) => {
    const name = deriveFolderName(
      c.topTermsTfIdf.length > 0 ? c.topTermsTfIdf : ["cluster"],
      used,
    );
    used.add(name);
    return name;
  });
}
