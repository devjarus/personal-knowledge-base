/**
 * Core types for the knowledge base.
 * These are shared across the web UI, MCP server, and CLI — a single source
 * of truth for what a "note" is in this system.
 */

export interface Frontmatter {
  title?: string;
  tags?: string[];
  type?: string;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export interface Note {
  /** Relative path from KB_ROOT, always using forward slashes. e.g. "projects/kb.md" */
  path: string;
  /** Filename without extension. */
  slug: string;
  /** Parsed YAML frontmatter (may be empty object). */
  frontmatter: Frontmatter;
  /** Markdown body, without the frontmatter block. */
  body: string;
  /** Raw file contents (frontmatter + body), useful for write-back. */
  raw: string;
  /** File stats. */
  size: number;
  mtime: string;
}

export interface NoteSummary {
  path: string;
  slug: string;
  title: string;
  tags: string[];
  type?: string;
  mtime: string;
  size: number;
  preview: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
}
