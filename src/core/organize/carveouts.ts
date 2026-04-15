/**
 * carveouts.ts — determines whether a note is excluded from organize scope.
 *
 * Baked-in carve-outs (always on):
 *   - Any path segment starting with "." (dotfiles, .kb-index/, .trash/, etc.)
 *   - meta/ subtree — hand-curated session notes + project docs
 *   - daily/ subtree — date-structured journal; moving breaks date navigation
 *   - Frontmatter `organize: false`
 *   - Frontmatter `pinned: true`
 *
 * The caller may extend the list with additional glob patterns via `extraGlobs`.
 * Extra globs are matched using a minimal built-in glob matcher (no new deps).
 */

import type { Frontmatter } from "../types.js";

// ---------------------------------------------------------------------------
// Baked-in folder prefixes that are always excluded.
// ---------------------------------------------------------------------------

const CARVEDOUT_PREFIXES = ["meta/", "daily/"];

// ---------------------------------------------------------------------------
// Minimal glob matcher for extraGlobs support.
//
// Supports only two wildcard tokens:
//   **   — matches any number of path segments (zero or more)
//   *    — matches any character sequence within a single segment (no slash)
//
// This is the minimal set needed to express patterns like "imports/archive/**".
// No new dependencies: implemented as a regex converter.
// ---------------------------------------------------------------------------

function globToRegex(glob: string): RegExp {
  // Escape regex special chars except * and /.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // Replace ** with a placeholder, then * with [^/]+, then restore **.
  const pattern = escaped
    .replace(/\*\*/g, "\x00") // placeholder for **
    .replace(/\*/g, "[^/]*")  // * → match within a single segment
    .replace(/\x00/g, ".*");  // ** → match anything (including slashes)
  return new RegExp(`^${pattern}$`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the note at `relPath` should be excluded from organize.
 *
 * @param relPath       KB-relative path with forward slashes, no leading slash.
 * @param frontmatter   Parsed frontmatter of the note.
 * @param extraGlobs    Additional glob patterns to exclude (extends the baked-in list).
 */
export function isCarvedOut(
  relPath: string,
  frontmatter: Frontmatter,
  extraGlobs: string[]
): boolean {
  // 1. Dotfile check: any segment starting with "." makes it a carve-out.
  //    Covers: .foo.md, .kb-index/x.md, .trash/*, folder/.hidden/note.md, etc.
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (seg.startsWith(".")) return true;
  }

  // 2. Baked-in folder prefixes.
  for (const prefix of CARVEDOUT_PREFIXES) {
    if (relPath === prefix.slice(0, -1) || relPath.startsWith(prefix)) {
      return true;
    }
  }

  // 3. Frontmatter flags.
  if (frontmatter.organize === false) return true;
  if (frontmatter.pinned === true) return true;

  // 4. Extra globs provided by the caller.
  for (const glob of extraGlobs) {
    if (globToRegex(glob).test(relPath)) return true;
  }

  return false;
}
