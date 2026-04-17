/**
 * render.ts — Renders a GeneratedSummary into a complete _summary.md file.
 *
 * Output format:
 *   1. YAML frontmatter (as specified in spec.md data model)
 *   2. H1: "# Summary — <clusterBasename>"
 *   3. ## Themes (bullet list)
 *   4. ## Key points (bullet list)
 *   5. ## Open questions (bullet list; omit section if empty)
 *   6. ## Sources (wiki-links, one per line)
 *
 * The frontmatter includes a comment explaining how to opt out of future
 * learn runs (set organize: false + remove type: cluster-summary).
 */

import path from "node:path";
import type { GeneratedSummary } from "./prompts";

/** Generator tier — duplicated here to avoid circular import with learn.ts. */
type LearnGenerator = "ollama" | "extractive";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RenderInput {
  clusterName: string;      // becomes the H1 ("Summary — <name>")
  cluster: string;          // KB-relative cluster path
  sources: string[];        // sorted KB-relative paths
  sourceHashes: string[];   // matching sha256 list (sorted, parallel to sources)
  generator: LearnGenerator;
  model: string | null;     // "llama3.2" for ollama; null for extractive
  summary: GeneratedSummary;
  generatedAt: string;      // ISO timestamp
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate the model field value for the frontmatter.
 * "ollama:<model>" for Ollama; "extractive" for extractive tier.
 */
function modelField(generator: LearnGenerator, model: string | null): string {
  if (generator === "ollama" && model) {
    return `ollama:${model}`;
  }
  return "extractive";
}

/**
 * Serialize a YAML string scalar — wraps in quotes if value contains special chars.
 * Simple implementation sufficient for the fields we need to write.
 */
function yamlStr(value: string): string {
  // If the string contains characters that require quoting, wrap in double quotes.
  if (/[:#\[\]{},|>&*!,?%@`'"\n\\]/.test(value) || value.startsWith(" ") || value.endsWith(" ")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Format a YAML list of strings, each on its own indented line.
 */
function yamlList(items: string[]): string {
  return items.map((item) => `  - ${yamlStr(item)}`).join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a complete _summary.md file (frontmatter + markdown body + Sources).
 *
 * @returns Complete file contents as a UTF-8 string.
 */
export function renderSummary(input: RenderInput): string {
  const {
    clusterName,
    cluster,
    sources,
    sourceHashes,
    generator,
    model,
    summary,
    generatedAt,
  } = input;

  const modelValue = modelField(generator, model);
  const clusterBasename = path.basename(cluster);
  const sourceCount = sources.length;

  // ---------------------------------------------------------------------------
  // Build YAML frontmatter manually.
  // We do NOT use gray-matter.stringify here because it doesn't support:
  //   - preserving the order of fields
  //   - emitting the opt-out comment
  //   - inline arrays vs block arrays per-field
  // LOAD-BEARING: field order matches spec.md data model exactly.
  // ---------------------------------------------------------------------------

  const sourceHashesYaml =
    sourceHashes.length > 0
      ? `sourceHashes:\n${yamlList(sourceHashes)}`
      : "sourceHashes: []";

  const sourcesYaml =
    sources.length > 0
      ? `sources:\n${yamlList(sources)}`
      : "sources: []";

  const frontmatter = [
    "---",
    `# To opt out of future kb learn runs: set organize: false AND remove the`,
    `# type: cluster-summary line below. Then kb learn will treat this as a user note.`,
    `type: cluster-summary`,
    `generator: kb-learn@0.1.0`,
    `cluster: ${yamlStr(cluster)}`,
    `generatedAt: "${generatedAt}"`,
    `sourceCount: ${sourceCount}`,
    sourceHashesYaml,
    `model: ${yamlStr(modelValue)}`,
    sourcesYaml,
    `organize: false`,
    `pinned: true`,
    "---",
  ].join("\n");

  // ---------------------------------------------------------------------------
  // Build markdown body
  // ---------------------------------------------------------------------------

  const lines: string[] = [];

  // H1
  lines.push(`# Summary — ${clusterBasename}`);
  lines.push("");

  // ## Themes
  lines.push("## Themes");
  lines.push("");
  for (const theme of summary.themes) {
    lines.push(`- ${theme}`);
  }
  lines.push("");

  // ## Key points
  lines.push("## Key points");
  lines.push("");
  for (const point of summary.keyPoints) {
    lines.push(`- ${point}`);
  }
  lines.push("");

  // ## Open questions (omit section if empty)
  if (summary.openQuestions.length > 0) {
    lines.push("## Open questions");
    lines.push("");
    for (const q of summary.openQuestions) {
      lines.push(`- ${q}`);
    }
    lines.push("");
  }

  // ## Sources — wiki-links
  lines.push("## Sources");
  lines.push("");
  for (const src of sources) {
    lines.push(`- [[${src}]]`);
  }
  lines.push("");

  const body = lines.join("\n");

  return `${frontmatter}\n${body}`;
}
