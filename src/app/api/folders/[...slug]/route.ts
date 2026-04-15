import { NextResponse } from "next/server";
import { deleteFolder } from "@/core/fs";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string[] }> };

function pathFromSlug(slug: string[]): string {
  return decodeURIComponent(slug.join("/"));
}

/**
 * DELETE /api/folders/<folder-path>
 *
 * Recursively delete a folder under KB_ROOT and every note inside it.
 * Guarded by core/fs.ts `deleteFolder` safety rails (no root, no escape,
 * no .kb-index). Returns `{ deleted: <count> }` on success.
 */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { slug } = await params;
  const relPath = pathFromSlug(slug);
  try {
    const count = await deleteFolder(relPath);
    return NextResponse.json({ ok: true, deleted: count });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
