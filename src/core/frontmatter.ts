import matter from "gray-matter";
import type { Frontmatter } from "./types";

/** Parse a raw file into { frontmatter, body }. Missing frontmatter is OK. */
export function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const parsed = matter(raw);
  return {
    frontmatter: (parsed.data ?? {}) as Frontmatter,
    body: parsed.content.replace(/^\n+/, ""),
  };
}

/** Serialize frontmatter + body back into a single markdown string. */
export function serializeFrontmatter(fm: Frontmatter, body: string): string {
  const hasFm = Object.keys(fm).length > 0;
  if (!hasFm) return body.endsWith("\n") ? body : body + "\n";
  return matter.stringify(body, fm);
}

/** Derive a human-friendly title: frontmatter.title → first H1 → filename. */
export function deriveTitle(fm: Frontmatter, body: string, slug: string): string {
  if (typeof fm.title === "string" && fm.title.trim()) return fm.title.trim();
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return slug.replace(/[-_]/g, " ");
}
