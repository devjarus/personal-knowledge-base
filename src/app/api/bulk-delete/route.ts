import { NextResponse } from "next/server";
import { deleteNote, deleteFolder } from "@/core/fs";

export const dynamic = "force-dynamic";

interface DeleteItem {
  path: string;
  type: "file" | "folder";
}

/**
 * POST /api/bulk-delete
 * Body: { items: DeleteItem[] }
 *
 * Deletes each item sequentially (intentionally — not parallel — so the
 * listNotes cache invalidation + semantic-index hook fires per item in
 * stable order). Reports per-item success/failure so the UI can show a
 * partial-success toast.
 *
 * Folders delete before files of the same ancestor wouldn't double-delete
 * because deleteFolder removes the whole subtree at once; but we still sort
 * by path length desc (deepest first) so a user selecting both `foo` and
 * `foo/bar.md` doesn't get a "does not exist" error on the file when the
 * folder delete already removed it. Folder-owns-file is deduped here.
 */
export async function POST(req: Request) {
  let body: { items?: DeleteItem[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json(
      { error: "items must be a non-empty array" },
      { status: 400 },
    );
  }

  // Dedupe: if a folder is selected, drop any files/folders under it.
  const folderPaths = items
    .filter((i) => i.type === "folder")
    .map((i) => i.path.replace(/\/+$/, ""));
  const isShadowed = (itemPath: string) =>
    folderPaths.some(
      (fp) => itemPath !== fp && (itemPath === fp || itemPath.startsWith(fp + "/")),
    );
  const deduped = items.filter((i) => !isShadowed(i.path));

  // Deepest-first so folder deletes don't orphan pending file deletes.
  deduped.sort((a, b) => b.path.length - a.path.length);

  const results: {
    path: string;
    type: "file" | "folder";
    ok: boolean;
    deleted?: number;
    error?: string;
  }[] = [];
  let totalNotes = 0;

  for (const item of deduped) {
    try {
      if (item.type === "folder") {
        const count = await deleteFolder(item.path);
        totalNotes += count;
        results.push({ path: item.path, type: "folder", ok: true, deleted: count });
      } else {
        await deleteNote(item.path);
        totalNotes += 1;
        results.push({ path: item.path, type: "file", ok: true, deleted: 1 });
      }
    } catch (e) {
      results.push({
        path: item.path,
        type: item.type,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const failures = results.filter((r) => !r.ok).length;
  return NextResponse.json({
    ok: failures === 0,
    totalNotes,
    results,
  });
}
