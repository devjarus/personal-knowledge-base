/**
 * learn.ts — Public entry point for the learnings pipeline.
 *
 * Phase 1: buildLearnPlan() — pure plan-building (no writes, no Ollama).
 * Phase 2: applyLearnPlan() + undoLastLearn().
 * Phase 3: Ollama generator + real embeddings wired into applyLearnPlan.
 *
 * Public API is locked across all phases (see plan.md "Locked public API").
 */

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import { kbRoot } from "./paths";
import { readNote, moveToTrash } from "./fs";
import { isCarvedOut } from "./organize/carveouts";
import { discoverClusters } from "./learn/clusters";
import { hashSources, readExistingSummary } from "./learn/sourceHashes";
import { generateExtractive } from "./learn/extractiveGenerator";
import { renderSummary } from "./learn/render";
import {
  acquireLock,
  releaseLock,
  isLockHeld,
} from "./ledger";
import {
  learnLedgerDir,
  learnLockPath,
  newLearnLedgerPath,
  appendLearnRecord,
  readLearnLedger,
  findLatestLearnLedger,
} from "./learn/ledger";
import type { LearnLedgerWriteRecord } from "./learn/ledger";
import { lockPath as organizeLockPath } from "./organize/ledger";
import {
  generateOllama,
  probeLearnOllama,
  resolveLearnOllamaUrl,
  resolveLearnModel,
} from "./learn/ollamaGenerator";
import { loadIndex } from "./semanticIndex";

// ---------------------------------------------------------------------------
// Public types — locked cross-phase contract
// ---------------------------------------------------------------------------

export type LearnGenerator = "ollama" | "extractive";

export type LearnStatus = "new" | "stale" | "fresh" | "skipped";

export interface LearnClusterPlan {
  /** KB-relative folder path, no leading slash. */
  cluster: string;
  /** KB-relative paths of the source markdown files, sorted. */
  sources: string[];
  /** SHA-256 of each source's raw bytes, sorted to match `sources`. */
  sourceHashes: string[];
  /** Absolute in-KB path the summary will be written to. Always `<cluster>/_summary.md`. */
  summaryPath: string;
  /** Planned generator tier for this cluster. */
  generator: LearnGenerator;
  /** Current state vs. any existing _summary.md in the cluster folder. */
  status: LearnStatus;
  /** Human-readable explanation when status === "skipped". */
  skipReason?: string;
}

export interface LearnPlan {
  generatedAt: string;           // ISO timestamp
  mode: "full" | "scoped";      // "scoped" when --cluster filter used
  generator: LearnGenerator;     // top-level planned tier (may vary per cluster at apply time)
  ollamaError?: string;          // set if Ollama probe failed during planning
  clusters: LearnClusterPlan[];
  stats: {
    total: number;               // count of eligible clusters
    new: number;                 // to-be-created summaries
    stale: number;               // to-be-regenerated summaries
    fresh: number;               // idempotent skips
    skipped: number;             // below minNotes or user-edited
  };
}

export interface BuildLearnPlanOptions {
  kbRoot?: string;               // test override
  clusters?: string[];           // KB-relative cluster folders; empty = all
  minNotes?: number;             // default 3 (env: KB_LEARN_MIN_NOTES)
  noLlm?: boolean;               // force extractive
  noOllama?: boolean;            // alias for noLlm in v1
  ollamaModel?: string;          // default "llama3.2" (env: KB_LEARN_MODEL)
  ollamaUrl?: string;            // default "http://localhost:11434"
  force?: boolean;               // ignore sourceHashes/fresh status
}

export interface LearnWriteResult {
  cluster: string;
  summaryPath: string;           // KB-relative
  generator: LearnGenerator;
  bytesWritten: number;
  /** true when we overwrote an existing _summary.md. */
  overwrote: boolean;
}

export interface ApplyLearnResult {
  applied: LearnWriteResult[];
  skipped: { cluster: string; reason: string }[];
  ledgerPath: string;            // absolute
  ollamaError?: string;          // set on fallthrough to extractive
}

export interface UndoLearnResult {
  restored: number;              // count of summaries restored-or-trashed
  conflicts: { path: string; reason: string }[];
  ledgerPath: string;            // absolute, renamed to .undone.jsonl
}

// ---------------------------------------------------------------------------
// ApplyLearnPlan options (Phase 3: adds Ollama control flags)
// ---------------------------------------------------------------------------

export interface ApplyLearnPlanOptions {
  force?: boolean;
  /** Force extractive tier — skip Ollama entirely. */
  noLlm?: boolean;
  /** Alias for noLlm (kept for CLI parity with organize). */
  noOllama?: boolean;
  /** Ollama model tag override (default: "llama3.2" or KB_LEARN_MODEL). */
  ollamaModel?: string;
  /** Ollama base URL override (default: "http://localhost:11434" or KB_LEARN_OLLAMA_URL). */
  ollamaUrl?: string;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class LearnError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "MISSING_INDEX_DIR"
      | "LOCK_HELD"
      | "NO_LEDGER"
      | "INVALID_CLUSTER"
  ) {
    super(message);
    this.name = "LearnError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the environment-configured minNotes, defaulting to 3.
 */
function resolveMinNotes(opts?: BuildLearnPlanOptions): number {
  if (opts?.minNotes !== undefined) return opts.minNotes;
  const envVal = process.env.KB_LEARN_MIN_NOTES;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 3;
}

/**
 * Derive a generator status by comparing sourceHashes and model tier.
 *
 * FR-18: status is "fresh" when sourceHashes match AND model tier matches.
 * "generator" in the plan refers to the tier (ollama|extractive); in the frontmatter
 * it's the tool name ("kb-learn@0.1.0"). The tier comparison uses the `model` field
 * ("extractive" or "ollama:*").
 *
 * @param existingHashes  sourceHashes from existing _summary.md, or null if no summary.
 * @param existingModel   model field from existing _summary.md ("extractive"|"ollama:*").
 * @param newHashes       freshly computed source hashes.
 * @param planGenerator   the tier we plan to use ("ollama"|"extractive").
 * @param force           if true, always return "stale" (ignores hash comparison).
 */
function classifyStatus(
  existingHashes: string[] | null,
  existingModel: string | null,
  newHashes: string[],
  planGenerator: LearnGenerator,
  force: boolean
): LearnStatus {
  if (existingHashes === null) return "new";
  if (force) return "stale";

  // Compare sorted hash arrays.
  const existing = [...existingHashes].sort();
  const computed = [...newHashes].sort();

  if (existing.length !== computed.length) return "stale";
  for (let i = 0; i < existing.length; i++) {
    if (existing[i] !== computed[i]) return "stale";
  }

  // Hashes match — check generator tier via the model field.
  // model field: "extractive" → tier "extractive"; "ollama:*" → tier "ollama".
  const expectedTier: string = planGenerator;
  const existingTier: string =
    existingModel?.startsWith("ollama:") ? "ollama" : (existingModel ?? "extractive");

  if (expectedTier !== existingTier) return "stale";

  return "fresh";
}

/**
 * Build a PromptNote excerpt from a note's body: first ~400 chars, whitespace-collapsed.
 */
function buildExcerpt(body: string): string {
  // Collapse multiple whitespace runs into single spaces, trim, then slice.
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, 400);
}

// ---------------------------------------------------------------------------
// buildLearnPlan — Phase 1 + Phase 3 (Ollama probe)
// ---------------------------------------------------------------------------

/**
 * Build a learn plan for the KB.
 *
 * Pure function: no writes. Discovers clusters, computes source hashes,
 * compares to any existing _summary.md, and classifies each cluster as
 * new/stale/fresh.
 *
 * Phase 3: Probes Ollama to determine the top-level generator tier.
 * If Ollama is unreachable or disabled, falls back to "extractive" and
 * sets `ollamaError` on the plan.
 */
export async function buildLearnPlan(opts?: BuildLearnPlanOptions): Promise<LearnPlan> {
  const root = opts?.kbRoot ?? kbRoot();
  const minNotes = resolveMinNotes(opts);
  const force = opts?.force ?? false;
  const noLlm = opts?.noLlm ?? opts?.noOllama ?? false;

  // --- Phase 3: Probe Ollama to determine the top-level generator tier ---
  let topGenerator: LearnGenerator = "extractive";
  let ollamaError: string | undefined;

  if (!noLlm) {
    const baseUrl = resolveLearnOllamaUrl(opts?.ollamaUrl);
    const modelTag = resolveLearnModel(opts?.ollamaModel);
    const probe = await probeLearnOllama(baseUrl, modelTag);
    if (!probe.available || probe.resolvedModel === null) {
      ollamaError = probe.error;
      topGenerator = "extractive";
    } else {
      topGenerator = "ollama";
    }
  }

  // Resolve cluster scope.
  const scopedClusters = opts?.clusters;
  const isScoped = scopedClusters !== undefined && scopedClusters.length > 0;

  // Validate scoped clusters exist.
  if (isScoped) {
    for (const clusterPath of scopedClusters!) {
      const absCluster = path.join(root, clusterPath);
      try {
        const stat = await fs.stat(absCluster);
        if (!stat.isDirectory()) {
          throw new LearnError(
            `cluster path is not a directory: ${clusterPath}`,
            "INVALID_CLUSTER"
          );
        }
      } catch (err) {
        if (err instanceof LearnError) throw err;
        throw new LearnError(
          `cluster path does not exist: ${clusterPath}`,
          "INVALID_CLUSTER"
        );
      }
    }
  }

  // Discover all clusters.
  const allClusters = await discoverClusters(root, { minNotes });

  // Filter to scoped clusters if requested.
  const candidateClusters = isScoped
    ? allClusters.filter((c) => scopedClusters!.includes(c.cluster))
    : allClusters;

  // For each cluster, also verify source notes are not carved out by frontmatter.
  // (discoverClusters does path-level checks; here we do FM-level checks.)
  const clusterPlans: LearnClusterPlan[] = [];
  let newCount = 0;
  let staleCount = 0;
  let freshCount = 0;
  let skippedCount = 0;

  for (const { cluster, notes } of candidateClusters) {
    // Filter notes by frontmatter carve-outs.
    const validNotes: string[] = [];
    for (const notePath of notes) {
      try {
        const note = await readNote(notePath);
        const fm = note.frontmatter;
        if (isCarvedOut(notePath, fm, [])) continue;
        validNotes.push(notePath);
      } catch {
        // Unreadable note — skip silently (edge case).
        continue;
      }
    }

    validNotes.sort();

    // Re-check minNotes after FM filtering.
    if (validNotes.length < minNotes) {
      skippedCount++;
      clusterPlans.push({
        cluster,
        sources: validNotes,
        sourceHashes: [],
        summaryPath: `${cluster}/_summary.md`,
        generator: topGenerator,
        status: "skipped",
        skipReason: `only ${validNotes.length} source note(s) after carve-out filter (min ${minNotes})`,
      });
      continue;
    }

    // Compute source hashes.
    let hashes: string[];
    try {
      hashes = await hashSources(root, validNotes);
    } catch {
      // Hashing failed (e.g., note disappeared) — skip this cluster.
      skippedCount++;
      clusterPlans.push({
        cluster,
        sources: validNotes,
        sourceHashes: [],
        summaryPath: `${cluster}/_summary.md`,
        generator: topGenerator,
        status: "skipped",
        skipReason: "could not hash source notes",
      });
      continue;
    }

    // Read existing summary for idempotency check.
    const existing = await readExistingSummary(root, cluster);

    const status = classifyStatus(
      existing?.sourceHashes ?? null,
      existing?.model ?? null,
      hashes,
      topGenerator,
      force
    );

    if (status === "new") newCount++;
    else if (status === "stale") staleCount++;
    else if (status === "fresh") freshCount++;

    clusterPlans.push({
      cluster,
      sources: validNotes,
      sourceHashes: hashes,
      summaryPath: `${cluster}/_summary.md`,
      generator: topGenerator,
      status,
    });
  }

  const plan: LearnPlan = {
    generatedAt: new Date().toISOString(),
    mode: isScoped ? "scoped" : "full",
    generator: topGenerator,
    clusters: clusterPlans,
    stats: {
      total: candidateClusters.length,
      new: newCount,
      stale: staleCount,
      fresh: freshCount,
      skipped: skippedCount,
    },
  };

  if (ollamaError !== undefined) {
    plan.ollamaError = ollamaError;
  }

  return plan;
}

// ---------------------------------------------------------------------------
// applyLearnPlan — Phase 2 + Phase 3 (Ollama + real embeddings)
// ---------------------------------------------------------------------------

/**
 * Apply a previously computed learn plan.
 *
 * Steps:
 *  1. Check organize lock (R-6 cross-feature guard, best-effort).
 *  2. Acquire learn lock.
 *  3. Load real embeddings from the sidecar (D5 fix — was empty map in Phase 2).
 *  4. Write header record.
 *  5. For each cluster with status "new" or "stale":
 *     - Re-hash sources to detect drift since planning.
 *     - R-5: if existing summary's contentHash != last-ledger hash → user edited.
 *       Skip unless opts.force.
 *     - Read existing content (if any) for previousContent capture.
 *     - Try Ollama if opts.noLlm is false; on null → fall through to extractive.
 *     - Record the actual tier used (fixes F7 latent "llama3.2" hardcode).
 *     - Render to markdown.
 *     - Atomic write (sibling tmp file — F6 fix: avoids EXDEV cross-device rename).
 *     - Append learning-write ledger record.
 *  6. For each cluster with status "fresh": skip (idempotent no-op).
 *  7. Write commit record.
 *  8. Release lock.
 */
export async function applyLearnPlan(
  plan: LearnPlan,
  opts?: ApplyLearnPlanOptions
): Promise<ApplyLearnResult> {
  const root = kbRoot();
  const force = opts?.force ?? false;
  const noLlm = opts?.noLlm ?? opts?.noOllama ?? false;
  const ollamaUrl = resolveLearnOllamaUrl(opts?.ollamaUrl);
  const ollamaModel = resolveLearnModel(opts?.ollamaModel);

  // Ensure ledger dir exists before lock acquisition.
  await fs.mkdir(learnLedgerDir(root), { recursive: true });

  // --- R-6: Cross-feature guard — warn if organize lock is held ---
  const orgLock = organizeLockPath(root);
  const orgLockHeld = await isLockHeld(orgLock);
  if (orgLockHeld) {
    process.stderr.write(
      "[learn] WARNING: organize lock is held — running kb learn while kb organize is active " +
        "may cause inconsistent state (R-6). Proceeding anyway (best-effort).\n"
    );
  }

  // --- Acquire learn lock ---
  const lp = learnLockPath(root);
  try {
    await acquireLock(lp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LearnError(`learn in progress (${msg})`, "LOCK_HELD");
  }

  // --- Load latest ledger for R-5 contentHash comparisons ---
  // LOAD-BEARING: must happen BEFORE we create the new ledger file, otherwise
  // findLatestLearnLedger would find the file we're about to create and
  // lastWrittenHash would be empty (no useful previous records to check).
  const prevLedgerPath = await findLatestLearnLedger(root);
  const lastWrittenHash = new Map<string, string>();
  if (prevLedgerPath) {
    const prevRecords = await readLearnLedger(prevLedgerPath);
    for (const rec of prevRecords) {
      if (rec.kind === "learning-write") {
        lastWrittenHash.set(rec.path, rec.contentHash);
      }
    }
  }

  // --- D5 fix: Load real embeddings from the sidecar ---
  // Previously this was `new Map()`, causing all notes to rank path-alphabetical
  // (cosine = -Infinity). Now we load the actual sidecar so centroid-based
  // ranking produces meaningful ordering for the extractive fallback tier.
  let embeddingIndex: Map<string, { vec: number[] }>;
  try {
    embeddingIndex = await loadIndex() as Map<string, { vec: number[] }>;
  } catch {
    // Sidecar unavailable (e.g. not yet indexed) — degrade gracefully.
    process.stderr.write(
      "[learn] WARN: could not load embedding sidecar; extractive tier will rank path-alphabetical.\n"
    );
    embeddingIndex = new Map();
  }

  // Convert IndexRow vec (number[]) → Float32Array for the extractive generator.
  const embeddings = new Map<string, Float32Array>();
  for (const [p, row] of embeddingIndex.entries()) {
    embeddings.set(p, new Float32Array(row.vec));
  }

  const ledgerPath = newLearnLedgerPath(root);
  const applied: LearnWriteResult[] = [];
  const skipped: { cluster: string; reason: string }[] = [];
  let runOllamaError: string | undefined;

  try {
    // --- Write header record ---
    await appendLearnRecord(ledgerPath, {
      kind: "header",
      generatedAt: plan.generatedAt,
      mode: plan.mode,
      generator: "kb-learn@0.1.0",
    });

    // --- Process each cluster ---
    for (const clusterPlan of plan.clusters) {
      const { cluster, sources, generator, status } = clusterPlan;

      // Skip clusters that don't need writes.
      if (status === "fresh" || status === "skipped") {
        skipped.push({ cluster, reason: status });
        continue;
      }

      // status is "new" or "stale".

      // Re-hash sources to detect drift since planning.
      let currentHashes: string[];
      try {
        currentHashes = await hashSources(root, sources);
      } catch {
        skipped.push({ cluster, reason: "source notes changed since planning (hash failed)" });
        continue;
      }

      // The summary path (KB-relative).
      const summaryRelPath = `${cluster}/_summary.md`;
      const summaryAbsPath = path.join(root, summaryRelPath);

      // --- R-5: Detect user edits to an existing summary ---
      let previousContent: string | null = null;
      let previousContentHash: string | null = null;

      if (status === "stale") {
        // There's an existing summary — read it.
        let existingBuf: Buffer | null = null;
        try {
          existingBuf = await fs.readFile(summaryAbsPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          // File disappeared between planning and apply — treat as new.
        }

        if (existingBuf !== null) {
          const currentHash = crypto.createHash("sha256").update(existingBuf).digest("hex");
          const lastHash = lastWrittenHash.get(summaryRelPath);

          // F5: We compare against the PREVIOUS-RUN ledger hash (lastHash), NOT the
          // current file's hash. The current file's hash already reflects any user
          // edits, making it impossible to detect drift from it. The ledger records
          // what we wrote last, so a mismatch from that baseline reveals the user's edit.
          if (lastHash !== undefined && currentHash !== lastHash) {
            if (!force) {
              skipped.push({ cluster, reason: "user edited summary since last learn run" });
              continue;
            }
            // force: proceed but log.
            process.stderr.write(
              `[learn] WARN: user-edited summary detected for ${cluster}; overwriting (--force).\n`
            );
          }

          // Capture previous content for undo.
          previousContent = existingBuf.toString("base64");
          previousContentHash = currentHash;
        }
      }

      // --- Build PromptInput from sources ---
      const promptNotes: Array<{ path: string; title: string; tags: string[]; excerpt: string }> = [];
      for (const notePath of sources) {
        try {
          const note = await readNote(notePath);
          const fm = note.frontmatter;
          const title =
            typeof fm.title === "string"
              ? fm.title
              : path.basename(notePath, ".md");
          const tags = Array.isArray(fm.tags)
            ? fm.tags.filter((t): t is string => typeof t === "string")
            : [];
          const excerpt = buildExcerpt(note.body ?? "");
          promptNotes.push({ path: notePath, title, tags, excerpt });
        } catch {
          // Unreadable note — include stub so extraction still has context.
          promptNotes.push({
            path: notePath,
            title: path.basename(notePath, ".md"),
            tags: [],
            excerpt: "",
          });
        }
      }

      const clusterName = path.basename(cluster);
      const promptInput = { clusterName, notes: promptNotes };

      // --- Phase 3: Generator tier selection ---
      // Three-tier-never-throws posture:
      //   noLlm=true  → extractive only
      //   else        → try Ollama; null return → fall through to extractive
      let summary: import("./learn/prompts").GeneratedSummary;
      let actualGenerator: LearnGenerator;
      // F7 fix: record the exact resolved model name, not a hardcoded "llama3.2".
      let actualModel: string | null = null;

      if (!noLlm && generator === "ollama") {
        const ollamaResult = await generateOllama(promptInput, {
          model: ollamaModel,
          baseUrl: ollamaUrl,
        });

        if (ollamaResult !== null) {
          summary = ollamaResult.summary;
          actualGenerator = "ollama";
          // Use the exact resolved model name (e.g. "llama3.2:3b" not "llama3.2").
          actualModel = ollamaResult.resolvedModel;
        } else {
          // Ollama failed — fall through to extractive.
          summary = generateExtractive(promptInput, embeddings);
          actualGenerator = "extractive";
          actualModel = null;
          runOllamaError = `Ollama failed for cluster ${cluster}; used extractive fallback`;
          process.stderr.write(
            `[learn] INFO: Ollama returned null for ${cluster}; falling back to extractive.\n`
          );
        }
      } else {
        // noLlm=true or cluster was already planned as extractive.
        summary = generateExtractive(promptInput, embeddings);
        actualGenerator = "extractive";
        actualModel = null;
      }

      // --- Render to markdown ---
      const content = renderSummary({
        clusterName,
        cluster,
        sources,
        sourceHashes: currentHashes,
        generator: actualGenerator,
        model: actualModel,
        summary,
        generatedAt: new Date().toISOString(),
      });

      const contentBuf = Buffer.from(content, "utf8");
      const contentHash = crypto.createHash("sha256").update(contentBuf).digest("hex");

      // --- Atomic write: sibling tmp file + rename ---
      // F6 fix: use a sibling tmp file (same directory as destination) instead of
      // os.tmpdir(). Using os.tmpdir() can cause EXDEV "cross-device link" errors
      // on Linux when tmpfs and the target filesystem are on different devices.
      await fs.mkdir(path.dirname(summaryAbsPath), { recursive: true });
      const tmpPath = path.join(
        path.dirname(summaryAbsPath),
        `.${path.basename(summaryAbsPath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      );
      await fs.writeFile(tmpPath, contentBuf);
      await fs.rename(tmpPath, summaryAbsPath);

      // --- Append ledger record ---
      // F7 fix: use actualGenerator and actualModel (exact resolved model name)
      // rather than the plan's generator or a hardcoded "llama3.2".
      await appendLearnRecord(ledgerPath, {
        kind: "learning-write",
        path: summaryRelPath,
        contentHash,
        generator: actualGenerator,
        model: actualModel,
        sourceHashes: currentHashes,
        previousContentHash,
        previousContent,
      });

      applied.push({
        cluster,
        summaryPath: summaryRelPath,
        generator: actualGenerator,
        bytesWritten: contentBuf.length,
        overwrote: previousContent !== null,
      });
    }

    // --- Write commit record ---
    await appendLearnRecord(ledgerPath, {
      kind: "commit",
      written: applied.length,
      skipped: skipped.length,
    });

    const result: ApplyLearnResult = { applied, skipped, ledgerPath };
    if (runOllamaError !== undefined) {
      result.ollamaError = runOllamaError;
    }
    return result;
  } finally {
    // Always release lock — even if we threw.
    await releaseLock(lp);
  }
}

// ---------------------------------------------------------------------------
// undoLastLearn — Phase 2 implementation
// ---------------------------------------------------------------------------

/**
 * Undo the most recent applied learn run.
 *
 * Steps:
 *  1. Find latest non-undone learn ledger.
 *  2. Acquire learn lock.
 *  3. Process learning-write records in reverse order:
 *     - If previousContent is null → file was new → moveToTrash.
 *     - Else → verify current contentHash matches what we wrote; if user-edited
 *       add to conflicts and leave in place; else write previousContent back.
 *  4. Rename ledger to .undone.jsonl.
 *  5. Release lock.
 */
export async function undoLastLearn(): Promise<UndoLearnResult> {
  const root = kbRoot();

  // --- 1. Find latest eligible ledger ---
  const ledgerPath = await findLatestLearnLedger(root);
  if (!ledgerPath) {
    throw new LearnError(
      "no learn ledger to undo — run 'kb learn --apply' first",
      "NO_LEDGER"
    );
  }

  // --- 2. Acquire lock ---
  const lp = learnLockPath(root);
  try {
    await acquireLock(lp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LearnError(`learn in progress (${msg})`, "LOCK_HELD");
  }

  let restored = 0;
  const conflicts: { path: string; reason: string }[] = [];

  try {
    // --- 3. Parse ledger ---
    const records = await readLearnLedger(ledgerPath);
    const writeRecords = records.filter(
      (r): r is LearnLedgerWriteRecord => r.kind === "learning-write"
    );

    // Process in reverse order (last write first).
    const toReverse = [...writeRecords].reverse();

    for (const record of toReverse) {
      const absPath = path.join(root, record.path);

      // Check if file currently exists.
      let currentBuf: Buffer | null = null;
      try {
        currentBuf = await fs.readFile(absPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // File was already removed (maybe a prior partial undo or manual delete).
          // Tolerate this as a no-op — crash-recovery partial-ledger safety.
          process.stderr.write(
            `[learn/undo] skipping missing file: ${record.path}\n`
          );
          continue;
        }
        throw err;
      }

      // Verify the current file matches what we wrote (edit detection).
      const currentHash = crypto.createHash("sha256").update(currentBuf).digest("hex");
      if (currentHash !== record.contentHash) {
        // File was edited since we wrote it — don't overwrite user content.
        conflicts.push({
          path: record.path,
          reason: "summary was modified after learn run; leaving in place",
        });
        continue;
      }

      // Restore the previous state.
      if (record.previousContent === null) {
        // Was a new file — move to trash.
        await moveToTrash(absPath, record.path);
      } else {
        // Was an overwrite — restore previous content via atomic write.
        // F6 fix: use a sibling tmp file (same directory) to avoid EXDEV errors.
        const prevBuf = Buffer.from(record.previousContent, "base64");
        const tmpPath = path.join(
          path.dirname(absPath),
          `.${path.basename(absPath)}.undo.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
        );
        await fs.writeFile(tmpPath, prevBuf);
        await fs.rename(tmpPath, absPath);
      }

      restored++;
    }

    // --- 4. Rename ledger to .undone.jsonl ---
    const undonePath = ledgerPath.replace(/\.jsonl$/, ".undone.jsonl");
    await fs.rename(ledgerPath, undonePath);

    return { restored, conflicts, ledgerPath: undonePath };
  } finally {
    // Always release lock — even on error.
    await releaseLock(lp);
  }
}
