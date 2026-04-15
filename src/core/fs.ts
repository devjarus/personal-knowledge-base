import fs from "node:fs/promises";
import path from "node:path";
import { kbRoot, resolveNotePath, toRelPath, withMarkdownExt } from "./paths";
import { parseFrontmatter, serializeFrontmatter, deriveTitle } from "./frontmatter";
import type { Frontmatter, Note, NoteSummary, TreeNode } from "./types";

// .kb-index is the semantic index sidecar directory — never treat as note content.
// .trash is the soft-delete bin — see TRASH_DIR / moveToTrash below.
const IGNORED = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  ".obsidian",
  ".kb-index",
  ".trash",
]);

/**
 * Soft-delete bin. Lives INSIDE the KB root so deletes never touch anything
 * outside the KB tree. Items are moved here under a timestamp directory with
 * their original relative path preserved, so recovery is `mv` on the shell.
 *
 *   <KB_ROOT>/.trash/<ISO-timestamp>/<original-rel-path>
 *
 * The .trash dir is excluded from listNotes / buildTree walks so trashed
 * content doesn't show up in search, sidebar, or the browser.
 *
 * We do not auto-prune. Clearing old trash is a user decision (manual rm
 * or a future `kb trash empty` command). Explicit and safe by default.
 */
const TRASH_DIR = ".trash";

function trashTimestamp(): string {
  // ISO timestamp, safe for use as a directory name across platforms.
  // Example: 2026-04-14T19-42-11-123Z
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function moveToTrash(absSource: string, relPath: string): Promise<void> {
  const root = kbRoot();
  const trashRoot = path.join(root, TRASH_DIR, trashTimestamp());
  const trashTarget = path.join(trashRoot, relPath);
  await fs.mkdir(path.dirname(trashTarget), { recursive: true });
  // rename first — atomic on the same filesystem. Falls back to copy+rm if
  // cross-device (rare but possible if KB_ROOT spans mount points).
  try {
    await fs.rename(absSource, trashTarget);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await fs.cp(absSource, trashTarget, { recursive: true });
      await fs.rm(absSource, { recursive: true, force: true });
    } else {
      throw err;
    }
  }

  // Sweep empty parent directories up to (but not including) the KB root.
  // Keeps the visible tree tidy after a lone file is soft-deleted. Stops at
  // the first non-empty directory or if rmdir errors (non-empty → ENOTEMPTY,
  // which we swallow). We never rmdir the root itself.
  let parent = path.dirname(absSource);
  while (parent !== root && parent.startsWith(root + path.sep)) {
    try {
      await fs.rmdir(parent); // only succeeds if empty
      parent = path.dirname(parent);
    } catch {
      break;
    }
  }
}

async function walkDir(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Module-scoped listNotes() cache
//
// Signature = "<count>:<maxMtimeMs>:<totalSize>" — computed from a stat-only
// walk (no file reads). Cache is keyed on kbRoot() so switching KB_ROOT
// between calls gets a fresh entry. _invalidateNotesCache() is exported and
// called from every write path (writeNote, deleteNote, import executor) so
// a write always triggers a re-read on the next listNotes() call, even if the
// OS mtime granularity hasn't advanced yet.
// ---------------------------------------------------------------------------

interface NotesCache {
  signature: string;
  summaries: NoteSummary[];
}

const _cache = new Map<string, NotesCache>();

export function _invalidateNotesCache(): void {
  _cache.delete(kbRoot());
}

// ---------------------------------------------------------------------------
// Notes-change hook (T4)
//
// `semanticIndex.ts` registers a callback here on module load to keep the
// embedding sidecar fresh after writes/deletes. `fs.ts` does NOT import
// `semanticIndex.ts` — the callback direction prevents the circular dep.
// Fire-and-forget: hook is called synchronously but not awaited, so write
// latency is bounded (FR-4, NFR-3).
// ---------------------------------------------------------------------------

type NotesChangeHook = (event: "write" | "delete", relPath: string) => void;
let _onChange: NotesChangeHook | null = null;

/** Register (or clear) a callback invoked after every writeNote / deleteNote. */
export function _registerNotesChangeHook(h: NotesChangeHook | null): void {
  _onChange = h;
}

/**
 * Return the current listNotes cache signature for a given kbRoot path.
 * Used by links.ts to detect when the KB has changed without re-running
 * a full listNotes() call — it just compares signatures.
 * Returns null if no cache entry exists yet for this root.
 */
export function _notesCacheSignature(root: string): string | null {
  return _cache.get(root)?.signature ?? null;
}

async function computeSignature(files: string[]): Promise<string> {
  let maxMtimeMs = 0;
  let totalSize = 0;
  await Promise.all(
    files.map(async (f) => {
      const st = await fs.stat(f);
      if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
      totalSize += st.size;
    }),
  );
  return `${files.length}:${maxMtimeMs}:${totalSize}`;
}

export async function ensureKbRoot(): Promise<void> {
  await fs.mkdir(kbRoot(), { recursive: true });
}

/** List all notes as summaries, sorted by mtime desc. */
export async function listNotes(): Promise<NoteSummary[]> {
  await ensureKbRoot();
  const root = kbRoot();
  const files = await walkDir(root);

  // Cheap stat-only pass to check whether the KB has changed since last call.
  const sig = await computeSignature(files);
  const cached = _cache.get(root);
  if (cached && cached.signature === sig) {
    return cached.summaries;
  }

  // Cache miss — read and parse every file.
  const summaries = await Promise.all(
    files.map(async (abs): Promise<NoteSummary> => {
      const raw = await fs.readFile(abs, "utf8");
      const stat = await fs.stat(abs);
      const { frontmatter, body } = parseFrontmatter(raw);
      const relPath = toRelPath(abs);
      const slug = path.basename(abs, ".md");
      const title = deriveTitle(frontmatter, body, slug);
      const tags = Array.isArray(frontmatter.tags)
        ? (frontmatter.tags as string[])
        : [];
      const preview = body
        .replace(/^#+\s+.*$/gm, "")
        .replace(/[*_`>]/g, "")
        .trim()
        .slice(0, 220);
      return {
        path: relPath,
        slug,
        title,
        tags,
        type: typeof frontmatter.type === "string" ? frontmatter.type : undefined,
        mtime: stat.mtime.toISOString(),
        size: stat.size,
        preview,
      };
    }),
  );
  summaries.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));

  _cache.set(root, { signature: sig, summaries });
  return summaries;
}

/** Read a single note by KB-relative path. */
export async function readNote(relPath: string): Promise<Note> {
  const abs = resolveNotePath(withMarkdownExt(relPath));
  const raw = await fs.readFile(abs, "utf8");
  const stat = await fs.stat(abs);
  const { frontmatter, body } = parseFrontmatter(raw);
  const slug = path.basename(abs, ".md");
  return {
    path: toRelPath(abs),
    slug,
    frontmatter,
    body,
    raw,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

export interface WriteNoteInput {
  path: string;
  body: string;
  frontmatter?: Frontmatter;
  /** If true, touches the `updated` field in frontmatter. */
  touchUpdated?: boolean;
}

/** Create or overwrite a note. Creates parent directories as needed. */
export async function writeNote(input: WriteNoteInput): Promise<Note> {
  const relPath = withMarkdownExt(input.path);
  const abs = resolveNotePath(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  const existing = await readNote(relPath).catch(() => null);
  // Use local date (not UTC) so `kb new` on a PT evening writes today's
  // local date rather than tomorrow's UTC date.
  const _d = new Date();
  const _pad = (n: number) => String(n).padStart(2, "0");
  const now = `${_d.getFullYear()}-${_pad(_d.getMonth() + 1)}-${_pad(_d.getDate())}`;
  const fm: Frontmatter = {
    ...(existing?.frontmatter ?? {}),
    ...(input.frontmatter ?? {}),
  };
  if (!existing && !fm.created) fm.created = now;
  if (input.touchUpdated !== false) fm.updated = now;

  const raw = serializeFrontmatter(fm, input.body);
  await fs.writeFile(abs, raw, "utf8");
  _invalidateNotesCache();
  // Fire-and-forget hook so write latency stays bounded (NFR-3).
  // semanticIndex.ts registers this hook to keep the embedding sidecar fresh.
  _onChange?.("write", relPath);
  return readNote(relPath);
}

/**
 * Soft-delete a note: moves it to `<KB_ROOT>/.trash/<timestamp>/<path>`.
 *
 * This NEVER calls fs.unlink on the real filesystem. The file continues to
 * exist inside the KB tree (just hidden from listNotes / UI / search) until
 * the user manually clears `.trash/`. Recovery is a shell `mv`.
 */
export async function deleteNote(relPath: string): Promise<void> {
  const normalized = withMarkdownExt(relPath);
  const abs = resolveNotePath(normalized);
  await moveToTrash(abs, normalized);
  _invalidateNotesCache();
  // Fire-and-forget hook so delete latency stays bounded (NFR-3).
  _onChange?.("delete", relPath);
}

/**
 * Soft-delete a folder under the KB root, including all notes within.
 *
 * Moves the folder into `<KB_ROOT>/.trash/<timestamp>/<path>`. No `fs.rm`
 * or `fs.unlink` on user content — the real filesystem still holds every
 * byte after a delete. Recovery is `mv .trash/<timestamp>/<path> <path>`.
 *
 * SAFETY RAILS (the move is still destructive to the visible tree):
 *  - Reject empty / root-pointing / absolute paths.
 *  - Reject paths that escape the KB root after normalization.
 *  - Reject the trash bin itself and the semantic-index sidecar.
 *  - The resolved path must be an existing directory, not a file.
 *
 * After success: invalidate listNotes cache, fire change hook per note
 * (semantic index drops those rows; hook is fire-and-forget, NFR-3).
 *
 * Returns the count of .md files that were moved to trash.
 */
export async function deleteFolder(relPath: string): Promise<number> {
  const cleaned = relPath.trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "/") {
    throw new Error("deleteFolder: path is empty or points to KB root");
  }
  if (path.isAbsolute(cleaned)) {
    throw new Error("deleteFolder: absolute paths not allowed");
  }
  if (cleaned === ".kb-index" || cleaned.startsWith(".kb-index/")) {
    throw new Error("deleteFolder: .kb-index is managed by kb reindex --force");
  }
  if (cleaned === TRASH_DIR || cleaned.startsWith(TRASH_DIR + "/")) {
    throw new Error(
      "deleteFolder: refusing to operate on .trash (use `kb trash empty` or shell rm)",
    );
  }

  const root = kbRoot();
  const abs = path.normalize(path.join(root, cleaned));
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error("deleteFolder: path escapes KB root");
  }
  if (abs === root) {
    throw new Error("deleteFolder: refusing to delete the KB root itself");
  }

  const st = await fs.stat(abs).catch(() => null);
  if (!st) throw new Error(`deleteFolder: ${cleaned} does not exist`);
  if (!st.isDirectory()) {
    throw new Error(`deleteFolder: ${cleaned} is not a directory`);
  }

  // Capture .md files BEFORE the move so the semantic hook fires per-note.
  const filesBefore = await walkDir(abs);
  const relPaths = filesBefore.map((f) => toRelPath(f));

  await moveToTrash(abs, cleaned);

  _invalidateNotesCache();
  for (const rp of relPaths) {
    _onChange?.("delete", rp);
  }
  return relPaths.length;
}

/** Build a tree representation of the KB directory for UI navigation. */
export async function buildTree(): Promise<TreeNode> {
  await ensureKbRoot();
  async function build(dir: string, relPrefix: string): Promise<TreeNode> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const children: TreeNode[] = [];
    for (const entry of entries) {
      if (IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        children.push(await build(full, rel));
      } else if (entry.name.endsWith(".md")) {
        children.push({ name: entry.name, path: rel, type: "file" });
      }
    }
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return {
      name: path.basename(dir),
      path: relPrefix,
      type: "directory",
      children,
    };
  }
  return build(kbRoot(), "");
}
