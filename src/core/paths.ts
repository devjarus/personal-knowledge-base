import path from "node:path";
import fs from "node:fs";

/**
 * Resolve where the KB lives on disk.
 *
 * Precedence:
 *   1. KB_ROOT env var (absolute or relative to cwd)
 *   2. ./kb relative to the current working directory
 *
 * We also walk upward from cwd looking for a `kb/` directory, so the CLI
 * and MCP server work from any subdirectory of the repo.
 */
export function kbRoot(): string {
  if (process.env.KB_ROOT) {
    return path.resolve(process.env.KB_ROOT);
  }

  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, "kb");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Last resort: ./kb next to cwd, even if it doesn't exist yet.
  return path.resolve(process.cwd(), "kb");
}

/**
 * Convert a relative KB path (as stored in Note.path) to an absolute
 * filesystem path, rejecting traversal attempts.
 */
export function resolveNotePath(relPath: string): string {
  const root = kbRoot();
  const normalized = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  const abs = path.resolve(root, normalized);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error(`Refusing path traversal: ${relPath}`);
  }
  return abs;
}

/** Convert an absolute path back to a KB-relative path with forward slashes. */
export function toRelPath(absPath: string): string {
  const rel = path.relative(kbRoot(), absPath);
  return rel.split(path.sep).join("/");
}

/** Ensure a path ends in .md, defaulting if missing. */
export function withMarkdownExt(p: string): string {
  return p.endsWith(".md") ? p : `${p}.md`;
}
