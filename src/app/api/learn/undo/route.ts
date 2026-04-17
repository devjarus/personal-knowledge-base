/**
 * POST /api/learn/undo
 *
 * Reverse the most recent applied learn run. Returns UndoLearnResult JSON:
 *   { restored: number, ledgerPath: string, conflicts: [{path, reason}] }
 *
 * Errors:
 *   - 404 when there's no ledger to undo (NO_LEDGER)
 *   - 409 when another learn is in progress (LOCK_HELD)
 */

import { NextResponse } from "next/server";
import { undoLastLearn, LearnError } from "@/core/learn";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await undoLastLearn();
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof LearnError) {
      if (e.code === "NO_LEDGER") {
        return NextResponse.json({ error: msg }, { status: 404 });
      }
      if (e.code === "LOCK_HELD") {
        return NextResponse.json(
          { error: `${msg}. If stale, remove .kb-index/learn/.lock.` },
          { status: 409 },
        );
      }
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
