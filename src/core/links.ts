/**
 * Link index: parses [[wiki]] and [text](path.md) links from note bodies,
 * builds inbound/outbound maps, and tracks broken links.
 *
 * No external markdown AST library — regex + line-based code-fence tracking.
 *
 * Cache strategy: module-scoped cache keyed by (kbRoot, listNotes signature).
 * When the listNotes signature changes (notes added/removed/modified) the link
 * index is rebuilt automatically. No callbacks needed between fs.ts and links.ts
 * — links.ts calls _notesCacheSignature() from fs.ts to compare.
 *
 * Dependency direction: links.ts → fs.ts only. fs.ts does NOT import links.ts.
 */

import path from "node:path";
import { listNotes, readNote, _notesCacheSignature } from "./fs.js";
import { kbRoot } from "./paths.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LinkRef {
  /** KB-relative source path */
  from: string;
  /** Raw link text as written in the source (for snippet / debug) */
  raw: string;
  /** Resolved KB-relative target path, or null if the link is broken */
  target: string | null;
  /** Either "wiki" ([[..]]) or "md" ([..](..)) */
  kind: "wiki" | "md";
}

export interface LinkIndex {
  /** target path → list of inbound LinkRefs (from other notes) */
  inbound: Map<string, LinkRef[]>;
  /** source path → list of outbound LinkRefs */
  outbound: Map<string, LinkRef[]>;
  /** all LinkRefs with target=null */
  broken: LinkRef[];
}

// ---------------------------------------------------------------------------
// Regexes
//
// wiki:  [[slug]]  [[folder/slug]]  [[slug#heading]]  [[slug|alias]]
// md:    [text](path.md)  [text](path.md#anchor)
//
// Both patterns are applied per-line (exec loop), not per-body, so the
// inCode toggle can gate them line-by-line.
// ---------------------------------------------------------------------------

/** Matches [[...content...]] capturing the bracket content (group 1). */
const WIKI_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Matches [text](url) capturing link text (group 1) and href (group 2).
 * Excludes image links (the `!` before `[` is NOT part of this pattern).
 * We skip matches that are preceded by `!` in the line-level scan below.
 */
const MD_RE = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;

// ---------------------------------------------------------------------------
// URL schemes to skip (non-KB links)
// ---------------------------------------------------------------------------
const SKIP_SCHEMES = ["http:", "https:", "mailto:", "tel:"];

// ---------------------------------------------------------------------------
// Inline-backtick masking
//
// Replace inline code spans with spaces of the same length before running
// the wiki/md regexes. This prevents false-positive broken links from text
// like `[[some-code]]` or `[text](path)` that appear inside inline code.
//
// We handle double-backtick spans first (`` `...` ``), then single-backtick
// spans (` ... `). Both are replaced with spaces to preserve string length
// so that any subsequent regex match indices remain valid.
//
// We do NOT attempt full CommonMark spec compliance — good-enough for our
// content: handles the common ``code`` and `code` patterns with no newlines.
// ---------------------------------------------------------------------------

/**
 * Mask inline backtick code spans in a single line by replacing each span
 * (including the surrounding backticks) with spaces of the same length.
 * Handles double-backtick (`` `` `` ) and single-backtick (`` ` ``) spans.
 * Line length is preserved so regex indices remain meaningful.
 */
export function maskInlineCode(line: string): string {
  // Double-backtick first (`` `...` ``), then single-backtick.
  // The regex is non-greedy and does not cross newlines (not needed — we
  // operate line-by-line).
  let result = line;

  // Replace ``...`` spans (double backtick). Allow inner single backticks
  // (the canonical CommonMark use — e.g. ``foo`bar``) by using `.+?` instead
  // of `[^``]`. Newlines still excluded because we operate line-by-line.
  result = result.replace(/``.+?``/g, (m) => " ".repeat(m.length));

  // Replace `...` spans (single backtick, but not inside already-replaced regions)
  result = result.replace(/`[^`\n]*?`/g, (m) => " ".repeat(m.length));

  return result;
}

// ---------------------------------------------------------------------------
// Parser
//
// Sweeps the note body line-by-line, toggling `inCode` on ``` fence lines,
// then applies both regexes to non-code lines. Returns raw LinkRef objects
// with target=null (resolution happens after all notes are parsed).
// ---------------------------------------------------------------------------

interface RawLink {
  raw: string;
  kind: "wiki" | "md";
  /** For wiki: the slug (after stripping #fragment and |alias). */
  slug?: string;
  /** For md: the href (after stripping #fragment). */
  href?: string;
}

function parseLinks(body: string): RawLink[] {
  const links: RawLink[] = [];
  const lines = body.split("\n");
  let inCode = false;

  for (const line of lines) {
    // Toggle code-fence state on lines that start (after optional whitespace)
    // with three or more backticks.
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;

    // Mask inline backtick code spans to prevent false-positive link matches.
    const maskedLine = maskInlineCode(line);

    // --- Wiki links ---
    // NOTE: we exec on maskedLine but retrieve raw text from the original line
    // using match index+length (lengths are preserved by maskInlineCode).
    WIKI_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_RE.exec(maskedLine)) !== null) {
      // Use original line for display (masked line has spaces where inline code was)
      const raw = line.slice(m.index, m.index + m[0].length); // [[...]] from original
      let content = m[1]; // the part inside [[ ]] (from masked — same content for non-code regions)

      // Strip pipe-alias: [[slug|display]] → slug
      const pipeIdx = content.indexOf("|");
      if (pipeIdx !== -1) content = content.slice(0, pipeIdx);

      // Strip fragment: [[slug#heading]] → slug
      const hashIdx = content.indexOf("#");
      if (hashIdx !== -1) content = content.slice(0, hashIdx);

      content = content.trim();
      if (content.length === 0) continue;

      links.push({ raw, kind: "wiki", slug: content });
    }

    // --- Markdown links ---
    MD_RE.lastIndex = 0;
    while ((m = MD_RE.exec(maskedLine)) !== null) {
      // Use original line for display; href comes from masked line (same for non-code regions)
      const raw = line.slice(m.index, m.index + m[0].length); // [text](href) from original
      let href = m[2]; // the URL/path part

      // Strip fragment: path.md#anchor → path.md
      const hashIdx = href.indexOf("#");
      if (hashIdx !== -1) href = href.slice(0, hashIdx);

      href = href.trim();
      if (href.length === 0) continue;

      links.push({ raw, kind: "md", href });
    }
  }

  return links;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a wiki slug to a KB-relative path given the full set of note paths.
 *
 * Resolution order (plan §T1):
 *   1. content + ".md" as exact KB-relative path
 *   2. content as exact KB-relative path (already has .md)
 *   3. Unique basename match (basename without .md == slug)
 *      If multiple notes share the basename → unresolved (ambiguous).
 *      This is a deliberate choice: picking one arbitrarily would silently
 *      hide broken links; forcing the author to use full paths is safer.
 *
 * Returns null if unresolved.
 */
function resolveWikiSlug(
  slug: string,
  notePaths: Set<string>,
  basenameIndex: Map<string, string[]>,
): string | null {
  // 1. Try slug + ".md"
  const withExt = slug.endsWith(".md") ? slug : `${slug}.md`;
  if (notePaths.has(withExt)) return withExt;

  // 2. Try slug as-is (might already end in .md and passed step 1, or be an unusual path)
  if (notePaths.has(slug)) return slug;

  // 3. Basename match
  // slug could be "folder/note" or just "note". Extract the basename without ext.
  const baseName = path.basename(slug, ".md");
  const candidates = basenameIndex.get(baseName) ?? [];
  if (candidates.length === 1) return candidates[0];
  // 0 → not found; >1 → ambiguous → null (intentional; see docstring)
  return null;
}

/**
 * Resolve a markdown href to a KB-relative path given the source note's path.
 *
 * - Skip absolute URLs (http/https/mailto/tel).
 * - Treat href as relative to source note's directory.
 * - path.normalize to collapse ../.. traversal.
 * - Reject if normalized path escapes the KB root.
 * - Attempt .md extension fallback if exact path not found.
 *
 * Returns null if unresolved (broken or non-KB link).
 * Returns undefined if the href should be skipped entirely (external URL, etc.).
 */
function resolveMdHref(
  href: string,
  sourceRelPath: string,
  notePaths: Set<string>,
  root: string,
): string | null | undefined {
  // Skip external URLs
  for (const scheme of SKIP_SCHEMES) {
    if (href.startsWith(scheme)) return undefined; // skip — not a KB link
  }

  // Treat as relative to the source note's directory.
  // sourceRelPath is KB-relative (e.g. "folder/note.md"), so its dir is "folder".
  const sourceDir = path.dirname(sourceRelPath); // "." if root-level
  // Resolve against KB root to get absolute, then make KB-relative again.
  const abs = path.normalize(path.join(root, sourceDir, href));

  // Reject paths that escape the KB root.
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    return undefined; // outside KB — skip silently
  }

  const rel = path.relative(root, abs).split(path.sep).join("/");

  // Exact match?
  if (notePaths.has(rel)) return rel;

  // Try adding .md
  const withExt = rel.endsWith(".md") ? rel : `${rel}.md`;
  if (notePaths.has(withExt)) return withExt;

  // Broken md link
  return null;
}

// ---------------------------------------------------------------------------
// Module-scoped cache
// ---------------------------------------------------------------------------

interface LinkIndexCache {
  /** The listNotes signature when this cache was built. */
  signature: string;
  index: LinkIndex;
}

const _linkCache = new Map<string, LinkIndexCache>();

/** Force-invalidate the link index cache (e.g., called from tests). */
export function _invalidateLinkIndexCache(): void {
  _linkCache.delete(kbRoot());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build (or return cached) the link index for the current KB.
 *
 * Piggy-backs on the listNotes() signature exposed via _notesCacheSignature().
 * If that signature is unchanged since last build, the cached index is returned.
 * Otherwise the index is rebuilt from scratch.
 */
export async function buildLinkIndex(): Promise<LinkIndex> {
  const root = kbRoot();

  // Get the current listNotes cache signature. This triggers a stat-only walk
  // but NOT a full re-read — listNotes() handles caching internally.
  const notes = await listNotes();
  const sig = _notesCacheSignature(root);

  // Return cached index if the KB hasn't changed.
  const cached = _linkCache.get(root);
  if (cached && sig !== null && cached.signature === sig) {
    return cached.index;
  }

  // Build a set of all note paths and a basename → paths[] index.
  const notePaths = new Set<string>(notes.map((n) => n.path));
  const basenameIndex = new Map<string, string[]>();
  for (const n of notes) {
    const base = path.basename(n.path, ".md");
    const existing = basenameIndex.get(base) ?? [];
    existing.push(n.path);
    basenameIndex.set(base, existing);
  }

  // Parse links from every note body in parallel.
  const allRefs = await Promise.all(
    notes.map(async (summary): Promise<LinkRef[]> => {
      let body: string;
      try {
        const note = await readNote(summary.path);
        body = note.body;
      } catch (err) {
        // If a note can't be read (e.g. race with deletion), skip it.
        // Not a silent swallow: the error is logged and we continue gracefully.
        console.error(`[core/links] could not read ${summary.path}:`, err);
        return [];
      }

      const rawLinks = parseLinks(body);
      const refs: LinkRef[] = [];

      for (const raw of rawLinks) {
        if (raw.kind === "wiki") {
          const target = resolveWikiSlug(raw.slug!, notePaths, basenameIndex);
          refs.push({ from: summary.path, raw: raw.raw, target, kind: "wiki" });
        } else {
          // md link
          const result = resolveMdHref(raw.href!, summary.path, notePaths, root);
          if (result === undefined) continue; // skip external/out-of-root links
          refs.push({ from: summary.path, raw: raw.raw, target: result, kind: "md" });
        }
      }

      return refs;
    }),
  );

  // Flatten and build the index.
  const inbound = new Map<string, LinkRef[]>();
  const outbound = new Map<string, LinkRef[]>();
  const broken: LinkRef[] = [];

  for (const refs of allRefs) {
    for (const ref of refs) {
      // Outbound
      const out = outbound.get(ref.from) ?? [];
      out.push(ref);
      outbound.set(ref.from, out);

      if (ref.target === null) {
        broken.push(ref);
      } else {
        // Inbound
        const inb = inbound.get(ref.target) ?? [];
        inb.push(ref);
        inbound.set(ref.target, inb);
      }
    }
  }

  const index: LinkIndex = { inbound, outbound, broken };
  // Cache with the current signature (use sig if available, else derive a
  // fresh one from notes length+mtime as a stable fallback).
  const cacheKey = sig ?? `${notes.length}:${notes[0]?.mtime ?? ""}`;
  _linkCache.set(root, { signature: cacheKey, index });

  return index;
}
