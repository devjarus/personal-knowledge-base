/**
 * prompts.ts — Prompt template + zod schema for the Ollama generator.
 *
 * The prompt is the authoritative single template from plan.md — LOCKED.
 * The zod schema `generatedSummarySchema` is also locked per plan.md.
 *
 * `buildPrompt` caps input at 30 notes (R-2: context overflow protection)
 * and truncates excerpts to ~400 chars.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PromptNote {
  path: string;     // KB-relative
  title: string;
  tags: string[];
  excerpt: string;  // first ~400 chars of body, whitespace-collapsed
}

export interface PromptInput {
  clusterName: string;  // e.g. "machine-learning"
  notes: PromptNote[];
}

export interface GeneratedSummary {
  themes: string[];          // 3-7 items
  keyPoints: string[];       // 3-10 items
  openQuestions: string[];   // 0-5 items
}

// ---------------------------------------------------------------------------
// Zod schema (locked — from plan.md)
// ---------------------------------------------------------------------------

export const generatedSummarySchema: z.ZodType<GeneratedSummary> = z.object({
  themes: z.array(z.string().min(1).max(80)).min(1).max(10),
  keyPoints: z.array(z.string().min(1).max(300)).min(1).max(15),
  openQuestions: z.array(z.string().min(1).max(300)).max(10),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of notes sent to the LLM per cluster (R-2: context overflow). */
const MAX_NOTES_PER_PROMPT = 30;

/** Maximum excerpt length per note, in characters. */
const MAX_EXCERPT_CHARS = 400;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the system + user prompt pair for the Ollama generator.
 *
 * Uses plain string concatenation — no template engine dependency.
 * The {{...}} syntax in plan.md was illustrative only.
 *
 * Caps input at 30 notes; truncates each excerpt to 400 chars.
 */
export function buildPrompt(input: PromptInput): { system: string; user: string } {
  const notes = input.notes.slice(0, MAX_NOTES_PER_PROMPT);

  const system = `You are a knowledge synthesizer for a personal markdown knowledge base.
Given a small set of notes from one topical folder, produce a concise
structured summary. Return ONLY a JSON object matching this schema — no
prose, no markdown, no backticks:

{
  "themes": string[],         // 3-7 short noun phrases, title case
  "keyPoints": string[],      // 3-10 declarative sentences, each under 30 words
  "openQuestions": string[]   // 0-5 questions (end with '?'), or []
}

Rules:
- Ground every keyPoint in at least one of the provided notes.
- Prefer specific claims over generic statements ("uses 12-layer transformers" beats "uses deep learning").
- If the notes conflict, surface the conflict as an open question.
- Omit boilerplate ("this note is about...").
- Do not cite notes by path in the JSON — citations are added later.`;

  const noteBlocks = notes
    .map((note) => {
      const excerpt = note.excerpt.slice(0, MAX_EXCERPT_CHARS);
      const tagsStr = note.tags.length > 0 ? note.tags.join(", ") : "none";
      return `---
Title: ${note.title}
Tags: ${tagsStr}
Path: ${note.path}

Excerpt:
${excerpt}`;
    })
    .join("\n\n");

  const user = `Folder: ${input.clusterName}

Notes (${notes.length}):

${noteBlocks}

Return the JSON object now.`;

  return { system, user };
}
