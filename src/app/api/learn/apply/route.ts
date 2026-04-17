/**
 * POST /api/learn/apply
 *
 * Apply a previously computed LearnPlan. The plan is passed in the body
 * verbatim (typically the same object returned by POST /api/learn/plan).
 *
 * LOAD-BEARING contract: the plan must include `clusters` in the exact
 * structure returned by buildLearnPlan. Any drift (e.g. stripping fields
 * on the client) breaks source-hash verification and ledger recording.
 *
 * Returns ApplyLearnResult JSON: { applied, skipped, ledgerPath, ollamaError? }.
 */

import { NextResponse } from "next/server";
import { applyLearnPlan, LearnError } from "@/core/learn";
import type { LearnPlan } from "@/core/learn";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: {
    plan?: LearnPlan;
    force?: boolean;
    noLlm?: boolean;
    noOllama?: boolean;
    ollamaModel?: string;
    ollamaUrl?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  if (!body.plan || !Array.isArray(body.plan.clusters)) {
    return NextResponse.json(
      { error: "body.plan is required and must be a full LearnPlan" },
      { status: 400 },
    );
  }

  try {
    const result = await applyLearnPlan(body.plan, {
      force: body.force,
      noLlm: body.noLlm,
      noOllama: body.noOllama,
      ollamaModel: body.ollamaModel,
      ollamaUrl: body.ollamaUrl,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof LearnError && e.code === "LOCK_HELD") {
      return NextResponse.json(
        {
          error: `${msg}. If stale, remove .kb-index/learn/.lock.`,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
