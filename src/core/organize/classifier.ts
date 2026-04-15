/**
 * classifier.ts — frontmatter-based note classification.
 *
 * Priority ladder (FR-O1 steps 1–2):
 *   1. Frontmatter `type: <name>` → target folder = `<name>/`
 *   2. Frontmatter `tags: [...]`  → primary tag seeds the folder;
 *      tie-break: if a tag matches an already-existing folder, it wins.
 *
 * Returns null if neither signal is present; the caller then falls back to
 * embedding-cluster classification.
 */

import type { NoteSummary } from "../types.js";

export interface ClassifyResult {
  folder: string;
  reason: "type" | "tag";
  confidence: 1.0;
}

/**
 * Classify a note purely by its frontmatter signals.
 *
 * @param summary         NoteSummary (path, tags, type — as returned by listNotes).
 * @param existingFolders Set of folder names that already exist in the KB tree.
 *                        Used for tag tie-breaking: existing folder name wins.
 * @returns               ClassifyResult or null if no frontmatter signal found.
 */
export function classifyByFrontmatter(
  summary: NoteSummary,
  existingFolders: Set<string>
): ClassifyResult | null {
  // Step 1: frontmatter `type` wins unconditionally.
  if (typeof summary.type === "string" && summary.type.trim().length > 0) {
    return { folder: summary.type.trim(), reason: "type", confidence: 1.0 };
  }

  // Step 2: frontmatter `tags`.
  if (Array.isArray(summary.tags) && summary.tags.length > 0) {
    const tags = summary.tags as string[];
    // Tie-break: if any tag matches an existing folder, use the first one that matches.
    for (const tag of tags) {
      if (existingFolders.has(tag)) {
        return { folder: tag, reason: "tag", confidence: 1.0 };
      }
    }
    // No existing-folder match → first tag wins.
    const primaryTag = tags[0];
    return { folder: primaryTag, reason: "tag", confidence: 1.0 };
  }

  return null;
}
