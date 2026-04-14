import fs from "node:fs/promises";
import path from "node:path";
import { kbRoot, resolveNotePath, toRelPath, withMarkdownExt } from "./paths";
import { parseFrontmatter, serializeFrontmatter, deriveTitle } from "./frontmatter";
import type { Frontmatter, Note, NoteSummary, TreeNode } from "./types";

const IGNORED = new Set([".git", "node_modules", ".DS_Store", ".obsidian"]);

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

export async function ensureKbRoot(): Promise<void> {
  await fs.mkdir(kbRoot(), { recursive: true });
}

/** List all notes as summaries, sorted by mtime desc. */
export async function listNotes(): Promise<NoteSummary[]> {
  await ensureKbRoot();
  const files = await walkDir(kbRoot());
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
  return readNote(relPath);
}

export async function deleteNote(relPath: string): Promise<void> {
  const abs = resolveNotePath(withMarkdownExt(relPath));
  await fs.unlink(abs);
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
