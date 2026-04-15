/**
 * folderName.ts — derive a slug-safe folder name from a list of top terms.
 *
 * Slugification rules:
 *   - Lowercase everything.
 *   - Replace any non-alphanumeric run with a single hyphen.
 *   - Strip leading/trailing hyphens.
 *   - Join up to the first 3 terms with "-".
 *
 * Collision avoidance:
 *   If the derived name already exists in `existingFolders`, append "-2", "-3", etc.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Slugify a single term.
 * @example slugify("RAG Eval") → "rag-eval"
 */
export function slugify(term: string): string {
  return term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Derive a collision-stable slug folder name from a ranked list of top terms.
 *
 * @param topTerms        Ranked terms (most-distinctive first). Must be non-empty.
 * @param existingFolders Set of folder names already used (for collision avoidance).
 * @returns               A slug-safe, unique folder name.
 */
export function deriveFolderName(
  topTerms: string[],
  existingFolders: Set<string>
): string {
  // Use up to first 3 terms joined by "-".
  const base = topTerms
    .slice(0, 3)
    .map(slugify)
    .filter((s) => s.length > 0)
    .join("-");

  // Fallback if all terms slugify to empty (shouldn't happen in practice).
  const safeName = base.length > 0 ? base : "unfiled";

  // Collision avoidance: append numeric suffix until unique.
  if (!existingFolders.has(safeName)) return safeName;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${safeName}-${i}`;
    if (!existingFolders.has(candidate)) return candidate;
  }
  // Unreachable in practice given the 1000-iteration cap.
  return `${safeName}-overflow`;
}
