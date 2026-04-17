/**
 * POST /api/organize/apply
 *
 * Apply a previously computed OrganizePlan. The plan is passed in the body
 * verbatim (typically the same object returned by POST /api/organize/plan).
 *
 * LOAD-BEARING contract: the plan must include `rewrites` and `moves` in the
 * exact structure returned by buildOrganizePlan. Any drift (e.g. stripping
 * fields on the client) breaks content-hash verification and link rewriting.
 *
 * Returns ApplyResult JSON: { applied, ledgerPath, skipped }.
 */

import { NextResponse } from "next/server";
import { applyOrganizePlan, OrganizeError } from "@/core/organize";
import type { OrganizePlan } from "@/core/organize";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { plan?: OrganizePlan; keepEmptyDirs?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  if (!body.plan || !Array.isArray(body.plan.moves)) {
    return NextResponse.json(
      { error: "body.plan is required and must be a full OrganizePlan" },
      { status: 400 },
    );
  }

  try {
    const result = await applyOrganizePlan(body.plan, {
      keepEmptyDirs: body.keepEmptyDirs,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof OrganizeError && e.code === "LOCK_HELD") {
      return NextResponse.json(
        {
          error: `${msg}. If stale, remove .kb-index/organize/.lock.`,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
