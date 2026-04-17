/**
 * POST /api/learn/plan
 *
 * Build a learn dry-run plan. No filesystem mutations. Returns the full
 * LearnPlan as JSON, matching the shape consumed by the CLI (--json).
 *
 * Request body (all fields optional):
 *   { noLlm?: boolean; noOllama?: boolean; ollamaModel?: string;
 *     ollamaUrl?: string; minNotes?: number; clusters?: string[] }
 *
 * Errors surface as `{ error: string }` with an appropriate HTTP status.
 */

import { NextResponse } from "next/server";
import { buildLearnPlan, LearnError } from "@/core/learn";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: {
    noLlm?: boolean;
    noOllama?: boolean;
    ollamaModel?: string;
    ollamaUrl?: string;
    minNotes?: number;
    clusters?: string[];
  } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — caller just wants defaults
  }

  try {
    const plan = await buildLearnPlan({
      noLlm: body.noLlm,
      noOllama: body.noOllama,
      ollamaModel: body.ollamaModel,
      ollamaUrl: body.ollamaUrl,
      minNotes: body.minNotes,
      clusters: body.clusters,
    });
    return NextResponse.json(plan);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Reindex-required errors get a 400 so the client can show a clear
    // "run kb reindex" message instead of a 500.
    if (e instanceof LearnError && e.code === "MISSING_INDEX_DIR") {
      return NextResponse.json(
        { error: "run `kb reindex` first — the embedding index is missing" },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
