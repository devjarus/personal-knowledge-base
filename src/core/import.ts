/**
 * Core library for bulk markdown import from an external folder.
 *
 * Design: plan-then-execute, same shape as src/core/sync.ts.
 * Every thrown Error begins with "import:" so the API route can classify
 * it as a 400 (user error) vs 500 (internal). This mirrors sync.ts's
 * KB_S3_BUCKET detection pattern.
 *
 * No React, no Next.js imports. Pure Node.
 */

import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { kbRoot } from "./paths";
import { _invalidateNotesCache } from "./fs";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ImportPlanEntry {
  sourceAbs: string;
  sourceRel: string;
  targetRel: string;
  resolvedDate: string; // ISO
  dateSource: "frontmatter-updated" | "frontmatter-created" | "mtime";
  status: "plan" | "skip-exists" | "skip-filter" | "skip-ignored" | "skip-unselected";
  bytes: number;
  parseWarnings?: string[]; // spec risk #2 mitigation
}

export interface ImportPlan {
  source: string;
  targetPrefix: string; // e.g. "imports/vault"
  from?: string; // ISO
  to?: string; // ISO
  entries: ImportPlanEntry[];
  counts: {
    planned: number;
    skippedExists: number;
    skippedFilter: number;
    skippedIgnored: number;
    skippedUnselected: number;
    totalScanned: number;
  };
}

/**
 * Default skip filters, matching the v1 hardcoded rules.
 * Exported so the UI can prefill the ignore-patterns textarea.
 * undefined or [] passed to importNotes() uses these defaults.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  ".*",
  "node_modules",
  "*.bak",
  "*.tmp",
  "*.swp",
  "*~",
] as const;

export interface ImportOptions {
  source: string; // absolute; caller expands ~
  from?: Date;
  to?: Date;
  overwrite?: boolean; // undefined → true
  dryRun?: boolean; // undefined → false
  /**
   * Override which path segments to skip. undefined or [] → use
   * DEFAULT_IGNORE_PATTERNS (same as v1). Non-empty → REPLACES the defaults
   * (not extends). Patterns follow three flavors:
   *   `.*`       — any segment starting with "."
   *   `*<suffix>` — case-insensitive suffix match
   *   `<exact>`  — case-sensitive exact match
   * Blank lines and lines starting with "#" are skipped.
   */
  ignorePatterns?: string[];
  /**
   * When set, only entries whose sourceAbs is in this list get written.
   * Entries that planned but were NOT selected appear in the returned plan
   * with status "skip-unselected" (AC-R16 discipline: empty array treated
   * the same as undefined — all planned entries are written).
   */
  selectedSources?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the value is a parseable non-NaN date.
 */
function isParseableDate(val: unknown): boolean {
  if (val instanceof Date) return !isNaN(val.getTime());
  if (typeof val === "string" || typeof val === "number") {
    const t = new Date(val).getTime();
    return Number.isFinite(t);
  }
  return false;
}

/**
 * Returns the epoch ms for a parseable value, throws if not parseable.
 */
function parseToEpoch(val: unknown): number {
  if (val instanceof Date) return val.getTime();
  return new Date(val as string).getTime();
}

/**
 * Normalize a Date to end-of-UTC-day (23:59:59.999Z) if the provided date
 * has zero time components (i.e. the user specified a bare date like
 * 2026-04-11, which parses as midnight UTC).
 *
 * Spec risk #3 mitigation: a `--to 2026-04-11` input should include any file
 * stamped 2026-04-11T23:00:00Z, not exclude it by being midnight.
 */
function normalizeToEndOfDay(d: Date): Date {
  if (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  ) {
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
    );
  }
  return d;
}

/**
 * Compile a list of ignore patterns into a single predicate that tests
 * one path segment at a time.
 *
 * Pattern semantics:
 *   `.*`          → any segment starting with "."  (dotfile rule)
 *   `*<suffix>`   → case-insensitive suffix match   (len > 1, starts with *)
 *   `<exact>`     → case-sensitive exact segment match
 *   blank / "#…"  → skipped (comment / empty line)
 *   any other shape → treated as exact-match (conservative fallback; never throws)
 */
function compileIgnorePatterns(
  patterns: readonly string[],
): (segment: string) => boolean {
  const dotfile = patterns.includes(".*");
  const exact = new Set<string>();
  const suffixes: string[] = []; // lowercased, including the leading non-* character(s)
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p || p.startsWith("#") || p === ".*") continue;
    if (p.startsWith("*") && p.length > 1) {
      // e.g. "*.bak" → suffix ".bak"; "*~" → suffix "~"
      suffixes.push(p.slice(1).toLowerCase());
    } else {
      exact.add(p);
    }
  }
  return (segment: string): boolean => {
    if (dotfile && segment.startsWith(".")) return true;
    if (exact.has(segment)) return true;
    const lower = segment.toLowerCase();
    for (const suf of suffixes) {
      if (lower.endsWith(suf)) return true;
    }
    return false;
  };
}

// Pre-compiled predicate for the v1 default patterns (used when no
// ignorePatterns option is supplied, preserving backward compatibility).
const defaultIsIgnored = compileIgnorePatterns(DEFAULT_IGNORE_PATTERNS);

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function importNotes(opts: ImportOptions): Promise<ImportPlan> {
  // -------------------------------------------------------------------------
  // Step 1: Validate source (FR-1)
  // -------------------------------------------------------------------------

  const src = path.resolve(opts.source);

  // Defensive guard — path.resolve always produces an absolute path, but
  // guard explicitly so the error message is recognizable.
  if (!path.isAbsolute(src)) {
    throw new Error(`import: source must be absolute: ${src}`);
  }

  let srcStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    srcStat = await fs.stat(src);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`import: source path does not exist: ${src}`);
    }
    throw new Error(`import: cannot stat source: ${src}: ${(err as Error).message}`);
  }

  if (!srcStat.isDirectory()) {
    throw new Error(`import: source is not a directory: ${src}`);
  }

  const kbAbs = path.resolve(kbRoot());

  if (src === kbAbs) {
    throw new Error(`import: source cannot be KB_ROOT: ${src}`);
  }
  if (src.startsWith(kbAbs + path.sep)) {
    throw new Error(`import: source cannot be inside KB_ROOT: ${src}`);
  }

  // FR-4 edge: empty basename after sanitization (e.g. source is "/")
  const baseName = path.basename(src).replace(/[/\0]/g, "").trim();
  if (!baseName) {
    throw new Error(`import: source basename is empty: ${src}`);
  }

  // -------------------------------------------------------------------------
  // Step 2: Determine filter bounds (FR-3)
  // Spec risk #3 mitigation: normalize bare dates to inclusive day boundaries.
  // -------------------------------------------------------------------------

  const fromEpoch =
    opts.from !== undefined ? opts.from.getTime() : undefined;

  const toEpoch =
    opts.to !== undefined
      ? normalizeToEndOfDay(opts.to).getTime()
      : undefined;

  // -------------------------------------------------------------------------
  // Step 3 & 4: Walk source and process files (FR-2, FR-3, FR-4, FR-5, FR-6)
  // -------------------------------------------------------------------------

  // Build the ignore predicate once per call. Empty array is treated the same
  // as undefined (use defaults) to preserve backward compatibility (AC-R10).
  const isIgnored: (segment: string) => boolean =
    opts.ignorePatterns && opts.ignorePatterns.length > 0
      ? compileIgnorePatterns(opts.ignorePatterns)
      : defaultIsIgnored;

  // Capture nowISO ONCE per importNotes call (all files share the same
  // imported_at; also makes AC-15's grep cleaner to reason about).
  const nowISO = new Date().toISOString();

  const entries: ImportPlanEntry[] = [];
  const counts = {
    planned: 0,
    skippedExists: 0,
    skippedFilter: 0,
    skippedIgnored: 0,
    skippedUnselected: 0,
    totalScanned: 0,
  };

  // Spec risk #4: case-collision tracking via lowercased set.
  const seenTargetLower = new Set<string>();

  // fs.readdir with recursive + withFileTypes returns Dirent<string>[] at runtime
  // but TypeScript's lib types may infer a buffer variant. Cast to avoid errors.
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = (await fs.readdir(src, {
      recursive: true,
      withFileTypes: true,
    })) as unknown as import("node:fs").Dirent[];
  } catch (err: unknown) {
    throw new Error(
      `import: failed reading source directory: ${src}: ${(err as Error).message}`,
    );
  }

  for (const entry of dirents) {
    // Skip symlinks (spec risk #5 — symlinked dirs would cause infinite loops
    // and symlinked files are excluded to keep behavior predictable).
    if (entry.isSymbolicLink()) continue;

    // Skip directories — recursive readdir emits all descendants, so we only
    // need to process file entries.
    if (entry.isDirectory()) continue;

    // Compute absolute and relative paths.
    // entry.parentPath is the Node 20+ field; entry.path is the deprecated alias.
    // Both are strings in Node 24.
    const parentDir =
      (entry as unknown as { parentPath?: string }).parentPath ??
      (entry as unknown as { path?: string }).path ??
      src;
    const absPath = path.join(parentDir, entry.name);
    const relPath = path.relative(src, absPath).split(path.sep).join("/");

    // Check ignore rules (FR-2) against all segments of the relative path.
    if (relPath.split("/").some(isIgnored)) {
      // Non-md ignored files are silently dropped (FR-14 says no entry for non-md)
      // but md files that are ignored DO get a skip-ignored entry.
      if (!entry.name.toLowerCase().endsWith(".md")) {
        // Silently drop — no entry (FR-14 extension check wins over ignore)
        continue;
      }
      // .md file but ignored → emit skip-ignored entry
      let fileStat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        fileStat = await fs.stat(absPath);
      } catch {
        // If we can't stat the ignored file, skip silently
        continue;
      }
      entries.push({
        sourceAbs: absPath,
        sourceRel: relPath,
        targetRel: ["imports", baseName, relPath].join("/"),
        resolvedDate: fileStat.mtime.toISOString(),
        dateSource: "mtime",
        status: "skip-ignored",
        bytes: fileStat.size,
      });
      counts.skippedIgnored++;
      continue;
    }

    // Non-.md files are silently dropped (FR-14) — no entry at all.
    if (!entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }

    // -----------------------------------------------------------------------
    // Per-file processing for surviving .md files
    // -----------------------------------------------------------------------

    let fileStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      fileStat = await fs.stat(absPath);
    } catch {
      // Skip files we can't stat (e.g. race condition, permissions)
      continue;
    }

    // Read body for frontmatter parsing
    let rawBody: string;
    try {
      rawBody = await fs.readFile(absPath, "utf8");
    } catch {
      // Skip unreadable files
      continue;
    }

    // Parse frontmatter — spec risk #2: wrap in try/catch; on failure treat
    // as "no frontmatter" and fall through to mtime for date resolution.
    let fm: Record<string, unknown> = {};
    let parsedBody = rawBody;
    const parseWarnings: string[] = [];

    try {
      const parsed = matter(rawBody);
      fm = parsed.data as Record<string, unknown>;
      parsedBody = parsed.content;
    } catch (err: unknown) {
      parseWarnings.push(
        `gray-matter parse error: ${(err as Error).message}; treating as no frontmatter`,
      );
    }

    // Resolve date for filtering (FR-3 fallback chain)
    let resolvedEpoch: number;
    let dateSource: ImportPlanEntry["dateSource"];

    if (isParseableDate(fm["updated"])) {
      resolvedEpoch = parseToEpoch(fm["updated"]);
      dateSource = "frontmatter-updated";
    } else if (isParseableDate(fm["created"])) {
      resolvedEpoch = parseToEpoch(fm["created"]);
      dateSource = "frontmatter-created";
    } else {
      resolvedEpoch = fileStat.mtime.getTime();
      dateSource = "mtime";
    }

    // Apply time-frame filter (inclusive both ends, FR-3)
    const passesFrom = fromEpoch === undefined || resolvedEpoch >= (fromEpoch as number);
    const passesTo = toEpoch === undefined || resolvedEpoch <= (toEpoch as number);

    const targetRel = ["imports", baseName, relPath].join("/");
    const resolvedDate = new Date(resolvedEpoch).toISOString();

    if (!passesFrom || !passesTo) {
      entries.push({
        sourceAbs: absPath,
        sourceRel: relPath,
        targetRel,
        resolvedDate,
        dateSource,
        status: "skip-filter",
        bytes: fileStat.size,
        ...(parseWarnings.length ? { parseWarnings } : {}),
      });
      counts.skippedFilter++;
      counts.totalScanned++;
      continue;
    }

    // Case-collision detection (spec risk #4): if a prior entry already
    // claimed this lowercased target, mark this entry as skip-exists.
    const targetLower = targetRel.toLowerCase();
    if (seenTargetLower.has(targetLower)) {
      entries.push({
        sourceAbs: absPath,
        sourceRel: relPath,
        targetRel,
        resolvedDate,
        dateSource,
        status: "skip-exists",
        bytes: fileStat.size,
        parseWarnings: [
          ...(parseWarnings.length ? parseWarnings : []),
          `case collision: another entry already maps to the same target (case-insensitive)`,
        ],
      });
      counts.skippedExists++;
      counts.totalScanned++;
      continue;
    }
    seenTargetLower.add(targetLower);

    // Existence check on disk (FR-6)
    const targetAbs = path.join(kbAbs, targetRel);
    const existsOnDisk = await fs.stat(targetAbs).then(
      () => true,
      () => false,
    );

    // overwrite default is true (undefined → true, per FR-6)
    if (existsOnDisk && opts.overwrite === false) {
      entries.push({
        sourceAbs: absPath,
        sourceRel: relPath,
        targetRel,
        resolvedDate,
        dateSource,
        status: "skip-exists",
        bytes: fileStat.size,
        ...(parseWarnings.length ? { parseWarnings } : {}),
      });
      counts.skippedExists++;
      counts.totalScanned++;
      continue;
    }

    // File passes all checks → plan to write
    entries.push({
      sourceAbs: absPath,
      sourceRel: relPath,
      targetRel,
      resolvedDate,
      dateSource,
      status: "plan",
      bytes: fileStat.size,
      ...(parseWarnings.length ? { parseWarnings } : {}),
    });
    counts.planned++;
    counts.totalScanned++;
  }

  // -------------------------------------------------------------------------
  // Step 5: Assemble the plan
  // -------------------------------------------------------------------------

  // totalScanned = planned + skippedExists + skippedFilter + skippedUnselected
  // skippedIgnored entries are NOT included in totalScanned per spec
  // (AC-1: "counts.planned + counts.skippedExists + counts.skippedFilter === counts.totalScanned")
  // skippedUnselected IS included because these files were scanned and reached planning
  // consideration — they only become unselected during the execute phase below.
  // The totalScanned value is set AFTER the execute loop (see below) so it
  // correctly reflects the post-selection counts.

  const plan: ImportPlan = {
    source: src,
    targetPrefix: `imports/${baseName}`,
    ...(opts.from !== undefined ? { from: opts.from.toISOString() } : {}),
    ...(opts.to !== undefined ? { to: opts.to.toISOString() } : {}),
    entries,
    counts: {
      ...counts,
      // Placeholder — will be corrected after execute loop below.
      totalScanned: counts.planned + counts.skippedExists + counts.skippedFilter,
    },
  };

  // -------------------------------------------------------------------------
  // Step 6: Execute (FR-9) — bounded-concurrency parallel writes
  // -------------------------------------------------------------------------

  if (!opts.dryRun) {
    // Build the selected-sources set once. Empty array = same as undefined
    // (AC-R16 discipline: backward compat — no behavior change without selectedSources).
    const selectedSet =
      opts.selectedSources && opts.selectedSources.length > 0
        ? new Set(opts.selectedSources)
        : null;

    // Pre-pass: filter unselected entries before concurrent execution so that
    // count mutations (planned--, skippedUnselected++) are serialized and never
    // race with the parallel write workers.
    for (const entry of entries) {
      if (entry.status !== "plan") continue;
      if (selectedSet !== null && !selectedSet.has(entry.sourceAbs)) {
        entry.status = "skip-unselected";
        plan.counts.planned--;
        plan.counts.skippedUnselected++;
      }
    }

    // Collect only the entries that still need to be written.
    const toWrite = entries.filter((e) => e.status === "plan");

    // Bounded-concurrency runner — no external dependency.
    // Uses a shared queue index consumed by N concurrent workers.
    // Target concurrency: 16 (I/O-bound; most files are small .md).
    // Error semantics: first worker failure cancels remaining work by setting
    // `failed`; workers check it before dequeuing the next item.
    await runBounded(toWrite, 16, async (entry) => {
      const targetAbs = path.join(kbAbs, entry.targetRel);

      try {
        await fs.mkdir(path.dirname(targetAbs), { recursive: true });

        // Re-read source to avoid holding large buffers in memory (spec risk #1)
        const rawContent = await fs.readFile(entry.sourceAbs, "utf8");

        // Parse with gray-matter (same try/catch for spec risk #2)
        let fmData: Record<string, unknown> = {};
        let bodyContent = rawContent;
        try {
          const parsed = matter(rawContent);
          fmData = parsed.data as Record<string, unknown>;
          bodyContent = parsed.content;
        } catch {
          // Parse failure: treat as no frontmatter; inject fresh YAML block
          fmData = {};
          bodyContent = rawContent;
        }

        // Inject provenance fields. Do NOT touch created, updated, title,
        // tags, or any other existing key (FR-7).
        fmData["imported_from"] = entry.sourceAbs;
        fmData["imported_at"] = nowISO;

        // matter.stringify(body, data) — first arg is body string, second is data.
        // Handles both: files with existing frontmatter (round-trips YAML, FR-11)
        // and files without (prepends fresh YAML block, FR-12).
        const output = matter.stringify(bodyContent, fmData);

        await fs.writeFile(targetAbs, output, "utf8");
      } catch (err: unknown) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`import: failed writing ${entry.targetRel}: ${cause}`);
      }
    });

    // Successful execute — bust the notes cache so the next listNotes() call
    // reflects the newly written files without waiting for mtime propagation.
    _invalidateNotesCache();
  }

  // -------------------------------------------------------------------------
  // Step 7: Fix totalScanned and return the plan
  // -------------------------------------------------------------------------

  // Recalculate totalScanned after execute loop, which may have moved entries
  // from "plan" → "skip-unselected".
  // totalScanned = planned + skippedExists + skippedFilter + skippedUnselected
  plan.counts.totalScanned =
    plan.counts.planned +
    plan.counts.skippedExists +
    plan.counts.skippedFilter +
    plan.counts.skippedUnselected;

  return plan;
}

// ---------------------------------------------------------------------------
// Bounded-concurrency helper
//
// Processes `items` with at most `limit` concurrent workers. Workers share a
// queue index; each one dequeues the next item until the list is exhausted or
// a failure occurs. On first error, remaining items are skipped and the error
// is re-thrown so the caller sees the original message.
// ---------------------------------------------------------------------------

async function runBounded<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  let failed: Error | null = null;

  async function consume(): Promise<void> {
    while (true) {
      if (failed) return; // another worker already failed — stop quietly
      const i = idx++;
      if (i >= items.length) return;
      await worker(items[i]).catch((err: unknown) => {
        // Record only the first failure; subsequent workers will check `failed`
        // before picking up more work and will exit early.
        if (!failed) {
          failed = err instanceof Error ? err : new Error(String(err));
        }
      });
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    consume(),
  );
  await Promise.all(workers);

  if (failed) throw failed;
}
