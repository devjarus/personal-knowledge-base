import { NextResponse } from "next/server";
import { getTrashStats, emptyTrash } from "@/core/fs";

export const dynamic = "force-dynamic";

/** GET /api/trash → { batches, files } */
export async function GET() {
  try {
    const stats = await getTrashStats();
    return NextResponse.json(stats);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/trash — permanently purges `<KB_ROOT>/.trash/` in its entirety.
 *
 * This is the only code path in the UI that calls `fs.rm` on user-adjacent
 * content. Scoped to `.trash/` only; the safety check lives in
 * `core/fs.ts#emptyTrash`.
 */
export async function DELETE() {
  try {
    const { files } = await emptyTrash();
    return NextResponse.json({ ok: true, deleted: files });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
