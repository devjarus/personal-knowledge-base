/**
 * POST /api/organize/undo
 *
 * Reverse the most recent applied organize. Returns UndoResult JSON:
 *   { reverted: number, ledgerPath: string, conflicts: [{path, reason}] }
 *
 * Errors:
 *   - 404 when there's no ledger to undo (NO_LEDGER)
 *   - 409 when another organize is in progress (LOCK_HELD)
 */

import { NextResponse } from "next/server";
import { undoLastOrganize, OrganizeError } from "@/core/organize";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await undoLastOrganize();
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof OrganizeError) {
      if (e.code === "NO_LEDGER") {
        return NextResponse.json({ error: msg }, { status: 404 });
      }
      if (e.code === "LOCK_HELD") {
        return NextResponse.json(
          { error: `${msg}. If stale, remove .kb-index/organize/.lock.` },
          { status: 409 },
        );
      }
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
