/**
 * POST /api/organize/plan
 *
 * Build an organize dry-run plan. No filesystem mutations. Returns the full
 * OrganizePlan as JSON, matching the shape consumed by the CLI (--json).
 *
 * Request body (all fields optional):
 *   { exclude?: string[]; minConfidence?: number; maxClusters?: number;
 *     rewriteLinks?: boolean; noLlm?: boolean; noOllama?: boolean;
 *     ollamaModel?: string; ollamaUrl?: string }
 *
 * Errors surface as `{ error: string }` with an appropriate HTTP status.
 */

import { NextResponse } from "next/server";
import { buildOrganizePlan, OrganizeError } from "@/core/organize";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: {
    exclude?: string[];
    minConfidence?: number;
    maxClusters?: number;
    rewriteLinks?: boolean;
    noLlm?: boolean;
    noOllama?: boolean;
    ollamaModel?: string;
    ollamaUrl?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — caller just wants defaults
  }

  try {
    const plan = await buildOrganizePlan({
      mode: "full",
      exclude: body.exclude,
      minConfidence: body.minConfidence,
      maxClusters: body.maxClusters,
      rewriteLinks: body.rewriteLinks,
      noLlm: body.noLlm,
      noOllama: body.noOllama,
      ollamaModel: body.ollamaModel,
      ollamaUrl: body.ollamaUrl,
    });
    return NextResponse.json(plan);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Reindex-required errors get a 400 so the client can show a clear
    // "run kb reindex" message instead of a 500.
    if (
      e instanceof OrganizeError &&
      (e.code === "MISSING_INDEX_DIR" || e.code === "MISSING_SIDECAR")
    ) {
      return NextResponse.json(
        { error: "run `kb reindex` first — the embedding index is missing" },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
