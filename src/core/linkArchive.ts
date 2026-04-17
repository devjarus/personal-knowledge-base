/**
 * linkArchive.ts — wire the imports/workspace/ archive into the link graph
 * via `## Related from archive` sections in cluster summaries.
 *
 * Problem: organize leaves `imports/workspace/**` alone (too cross-cutting to
 * cluster confidently), so those notes are search-only — invisible to
 * backlinks, orphans, and the link graph. This module builds a non-destructive
 * bridge: for each `_summary.md`, compute the cluster centroid from member
 * embeddings, rank all archive notes by cosine similarity, and append the
 * top-K as `[[wiki-links]]` inside a delimited block. Re-running replaces the
 * block rather than appending, so it's idempotent.
 *
 * Architecture: parallels learn.ts exactly (plan / apply / undo, PID-based
 * lock, JSONL ledger with byte-for-byte previousContent for undo). This is
 * deliberate so the pattern is familiar and the bugs are the same known bugs.
 *
 * Public API:
 *   buildLinkArchivePlan(opts?) → LinkArchivePlan
 *   applyLinkArchivePlan(plan)  → { ledgerPath, edits }
 *   undoLastLinkArchive()       → { reverted, ledgerPath }
 *
 * Ledger: <kbRoot>/.kb-index/link-archive/<ISO>.jsonl
 * Lock:   <kbRoot>/.kb-index/link-archive/.lock
 */

import fs from "node:fs/promises";
import path from "node:path";

import { kbRoot } from "./paths";
import { listNotes } from "./fs";
import { loadIndex } from "./semanticIndex";
import { acquireLock, releaseLock } from "./ledger";
import { lockPath as organizeLockPath } from "./organize/ledger";
import { learnLockPath } from "./learn/ledger";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArchiveLink {
  /** KB-relative path of the archive note. */
  path: string;
  /** Derived title (frontmatter.title → first heading → slug). */
  title: string;
  /** Cosine similarity to the cluster centroid. Higher = more related. */
  cosine: number;
}

export interface LinkArchiveEdit {
  /** KB-relative path of the `_summary.md` being edited. */
  summaryPath: string;
  /** Cluster folder the summary belongs to. */
  cluster: string;
  /** Count of cluster member notes used to compute centroid. */
  clusterSize: number;
  /** Archive links chosen for this summary, sorted by cosine desc. */
  links: ArchiveLink[];
  /** Raw summary file bytes before edit. */
  beforeContent: string;
  /** Raw summary file bytes after edit. */
  afterContent: string;
  /** True if the content is unchanged (before === after) — a no-op. */
  unchanged: boolean;
}

export interface LinkArchiveSkip {
  summaryPath: string;
  reason: string;
}

export interface LinkArchivePlan {
  generatedAt: string;
  /** Archive prefix considered when ranking candidates. */
  archivePrefix: string;
  /** Top-K size used. */
  topK: number;
  edits: LinkArchiveEdit[];
  skipped: LinkArchiveSkip[];
}

export interface BuildLinkArchiveOpts {
  /** Default: "imports/workspace/". Trailing slash required. */
  archivePrefix?: string;
  /** Default: 5. */
  topK?: number;
  /**
   * Minimum number of cluster members required to compute a meaningful
   * centroid. Below this, we skip (noise). Default: 2.
   */
  minClusterSize?: number;
}

// ---------------------------------------------------------------------------
// Block delimiters — idempotent detection
//
// HTML comments survive Markdown rendering invisibly and give us a precise
// scissor line. The block is *replaced* on each apply, not appended, so
// re-running with a different --top or different archive contents updates
// cleanly. If the block is absent, we append before the end-of-file (with a
// separating blank line).
// ---------------------------------------------------------------------------

const BLOCK_START = "<!-- related-archive:start -->";
const BLOCK_END = "<!-- related-archive:end -->";
const BLOCK_RE = new RegExp(
  `\\n*${escapeRegExp(BLOCK_START)}[\\s\\S]*?${escapeRegExp(BLOCK_END)}\\n*`,
  "m",
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function l2normalize(v: Float32Array): void {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n === 0) return;
  for (let i = 0; i < v.length; i++) v[i] /= n;
}

function dot(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

/** Convert the IndexRow.vec (number[]) into a Float32Array for cosine math. */
function toF32(vec: number[]): Float32Array {
  const f = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) f[i] = vec[i];
  return f;
}

// ---------------------------------------------------------------------------
// Block renderer
// ---------------------------------------------------------------------------

function renderBlock(links: ArchiveLink[]): string {
  if (links.length === 0) return "";
  const lines = [BLOCK_START];
  lines.push("");
  lines.push("## Related from archive");
  lines.push("");
  lines.push(
    "_Auto-generated by `kb link-archive`. Top matches from the archive at `imports/workspace/`, ranked by semantic similarity to this cluster. Re-run to refresh._",
  );
  lines.push("");
  for (const link of links) {
    // Wiki-link form so `buildLinkIndex()` picks it up and pumps backlinks
    // into the archive notes. Title in parens is aesthetic; the link itself
    // is what the link-graph uses.
    lines.push(`- [[${link.path.replace(/\.md$/, "")}]] — ${link.title}`);
  }
  lines.push("");
  lines.push(BLOCK_END);
  return lines.join("\n");
}

/**
 * Insert-or-replace the related-archive block in a summary file.
 * Returns the new raw content. If `links` is empty, strips the block entirely.
 */
export function applyRelatedBlock(
  existingContent: string,
  links: ArchiveLink[],
): string {
  const stripped = existingContent.replace(BLOCK_RE, "\n");
  // Preserve trailing newline convention.
  const base = stripped.replace(/\n+$/, "") + "\n";
  if (links.length === 0) return base;
  return `${base}\n${renderBlock(links)}\n`;
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export async function buildLinkArchivePlan(
  opts: BuildLinkArchiveOpts = {},
): Promise<LinkArchivePlan> {
  const archivePrefix = (opts.archivePrefix ?? "imports/workspace/").replace(
    /\/+$/,
    "",
  ) + "/";
  const topK = opts.topK ?? 5;
  const minClusterSize = opts.minClusterSize ?? 2;

  const [notes, index] = await Promise.all([listNotes(), loadIndex()]);

  // Pre-convert every indexed vector to Float32Array once; reuse across
  // summaries. (Eager is fine: the sidecar is already fully in memory.)
  const vecs = new Map<string, Float32Array>();
  for (const [path, row] of index) {
    vecs.set(path, toF32(row.vec));
  }

  // Archive candidate list (paths under archivePrefix with embeddings).
  const archivePaths: string[] = [];
  for (const p of vecs.keys()) {
    if (p.startsWith(archivePrefix)) archivePaths.push(p);
  }
  archivePaths.sort(); // stable

  const titleByPath = new Map<string, string>();
  for (const n of notes) titleByPath.set(n.path, n.title);

  const summaries = notes.filter((n) => n.type === "cluster-summary");

  const edits: LinkArchiveEdit[] = [];
  const skipped: LinkArchiveSkip[] = [];

  for (const summary of summaries) {
    const cluster = path.dirname(summary.path);
    if (cluster === ".") {
      skipped.push({
        summaryPath: summary.path,
        reason: "summary lives at KB root; no cluster folder",
      });
      continue;
    }

    // Cluster members: notes under this folder, excluding the summary itself
    // and any subfolder summaries (defensive — normally flat).
    const members = notes.filter(
      (n) =>
        n.path.startsWith(cluster + "/") &&
        n.path !== summary.path &&
        n.type !== "cluster-summary",
    );
    if (members.length < minClusterSize) {
      skipped.push({
        summaryPath: summary.path,
        reason: `cluster has ${members.length} member${members.length === 1 ? "" : "s"} — below minClusterSize=${minClusterSize}`,
      });
      continue;
    }

    // Centroid from member embeddings. L2-normalize so `dot` = cosine.
    let centroid: Float32Array | null = null;
    let vecCount = 0;
    for (const m of members) {
      const v = vecs.get(m.path);
      if (!v) continue;
      if (!centroid) centroid = new Float32Array(v.length);
      for (let i = 0; i < v.length; i++) centroid[i] += v[i];
      vecCount++;
    }
    if (!centroid || vecCount === 0) {
      skipped.push({
        summaryPath: summary.path,
        reason: "no member embeddings available (run `kb reindex` first)",
      });
      continue;
    }
    for (let i = 0; i < centroid.length; i++) centroid[i] /= vecCount;
    l2normalize(centroid);

    // Rank archive candidates by cosine to centroid. Each archive vec is
    // already L2-normalized at embed time (see semanticIndex.ts), so `dot`
    // on normalized centroid + normalized archive vec = cosine directly.
    const scored: ArchiveLink[] = [];
    for (const p of archivePaths) {
      const v = vecs.get(p);
      if (!v) continue;
      const cosine = dot(centroid, v);
      scored.push({
        path: p,
        title: titleByPath.get(p) ?? path.basename(p, ".md"),
        cosine,
      });
    }
    scored.sort((a, b) => {
      if (b.cosine !== a.cosine) return b.cosine - a.cosine;
      return a.path.localeCompare(b.path);
    });
    const topLinks = scored.slice(0, topK);

    // Build proposed content.
    const absSummary = path.join(kbRoot(), summary.path);
    const beforeContent = await fs.readFile(absSummary, "utf8");
    const afterContent = applyRelatedBlock(beforeContent, topLinks);

    edits.push({
      summaryPath: summary.path,
      cluster,
      clusterSize: members.length,
      links: topLinks,
      beforeContent,
      afterContent,
      unchanged: beforeContent === afterContent,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    archivePrefix,
    topK,
    edits,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Ledger — simple per-edit JSONL
// ---------------------------------------------------------------------------

interface LinkArchiveHeader {
  kind: "header";
  generatedAt: string;
  archivePrefix: string;
  topK: number;
  generator: string;
}

interface LinkArchiveEditRecord {
  kind: "edit";
  path: string;
  before: string; // base64 of previous bytes
  after: string; // base64 of new bytes (informational; undo uses `before`)
}

interface LinkArchiveCommit {
  kind: "commit";
  edits: number;
  skipped: number;
}

type LinkArchiveRecord =
  | LinkArchiveHeader
  | LinkArchiveEditRecord
  | LinkArchiveCommit;

function linkArchiveDir(root: string): string {
  return path.join(root, ".kb-index", "link-archive");
}

function linkArchiveLockPath(root: string): string {
  return path.join(linkArchiveDir(root), ".lock");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function appendRecord(
  ledgerPath: string,
  record: LinkArchiveRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(ledgerPath, JSON.stringify(record) + "\n", "utf8");
}

async function findLatestLedger(root: string): Promise<string | null> {
  const dir = linkArchiveDir(root);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const ledgers = entries
    .filter((e) => e.endsWith(".jsonl") && !e.endsWith(".undone.jsonl"))
    .sort();
  if (ledgers.length === 0) return null;
  return path.join(dir, ledgers[ledgers.length - 1]);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyLinkArchivePlan(
  plan: LinkArchivePlan,
): Promise<{ ledgerPath: string; edits: number; skipped: number }> {
  const root = kbRoot();
  const ourLock = linkArchiveLockPath(root);

  // Cross-feature lock coordination: refuse to run while organize or learn
  // are mid-apply. Their writes could shift file contents under us.
  if (await isLockHeldExternal(organizeLockPath(root))) {
    throw new Error(
      "refusing to apply: organize lock is held (another run in progress). If stuck, remove .kb-index/organize/.lock",
    );
  }
  if (await isLockHeldExternal(learnLockPath(root))) {
    throw new Error(
      "refusing to apply: learn lock is held (another run in progress). If stuck, remove .kb-index/learn/.lock",
    );
  }

  await acquireLock(ourLock);
  const ledgerPath = path.join(linkArchiveDir(root), `${timestamp()}.jsonl`);

  let written = 0;
  let skipped = 0;

  try {
    await appendRecord(ledgerPath, {
      kind: "header",
      generatedAt: plan.generatedAt,
      archivePrefix: plan.archivePrefix,
      topK: plan.topK,
      generator: "kb-link-archive@0.1.0",
    });

    for (const edit of plan.edits) {
      if (edit.unchanged) {
        skipped++;
        continue;
      }
      const abs = path.join(root, edit.summaryPath);
      // Atomic sibling-tmp write (avoid EXDEV risk of os.tmpdir across mounts).
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, edit.afterContent, "utf8");
      await fs.rename(tmp, abs);

      await appendRecord(ledgerPath, {
        kind: "edit",
        path: edit.summaryPath,
        before: Buffer.from(edit.beforeContent, "utf8").toString("base64"),
        after: Buffer.from(edit.afterContent, "utf8").toString("base64"),
      });
      written++;
    }

    await appendRecord(ledgerPath, {
      kind: "commit",
      edits: written,
      skipped,
    });
  } finally {
    await releaseLock(ourLock);
  }

  return { ledgerPath, edits: written, skipped };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export async function undoLastLinkArchive(): Promise<{
  reverted: number;
  ledgerPath: string | null;
}> {
  const root = kbRoot();
  const latest = await findLatestLedger(root);
  if (!latest) return { reverted: 0, ledgerPath: null };

  const raw = await fs.readFile(latest, "utf8");
  const records: LinkArchiveRecord[] = raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LinkArchiveRecord);

  const ourLock = linkArchiveLockPath(root);
  await acquireLock(ourLock);

  let reverted = 0;
  try {
    // Revert in reverse order (LIFO) so nested edits unwind cleanly — even
    // though currently every edit is independent, this matches the organize
    // pattern and is defensive against future batch changes.
    const edits = records.filter(
      (r): r is LinkArchiveEditRecord => r.kind === "edit",
    );
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i];
      const abs = path.join(root, e.path);
      const before = Buffer.from(e.before, "base64").toString("utf8");
      const tmp = `${abs}.tmp-undo-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, before, "utf8");
      await fs.rename(tmp, abs);
      reverted++;
    }

    // Mark ledger as consumed (same convention as learn/organize).
    const undonePath = latest.replace(/\.jsonl$/, ".undone.jsonl");
    await fs.rename(latest, undonePath);
  } finally {
    await releaseLock(ourLock);
  }

  return { reverted, ledgerPath: latest };
}

// ---------------------------------------------------------------------------
// External-lock probe (minimal copy of ledger.isLockHeld to avoid accidentally
// depending on its current signature).
// ---------------------------------------------------------------------------

async function isLockHeldExternal(lockPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const pid = Number(raw.trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return true; // signalable → alive
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false; // stale
      if (code === "EPERM") return true; // exists but not ours
      return false;
    }
  } catch {
    return false; // no lock file
  }
}

