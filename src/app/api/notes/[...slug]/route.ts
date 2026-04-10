import { NextResponse } from "next/server";
import { readNote, writeNote, deleteNote } from "@/core/fs";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string[] }> };

function pathFromSlug(slug: string[]): string {
  return decodeURIComponent(slug.join("/"));
}

export async function GET(_req: Request, { params }: Ctx) {
  const { slug } = await params;
  try {
    const note = await readNote(pathFromSlug(slug));
    return NextResponse.json(note);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }
}

export async function PUT(req: Request, { params }: Ctx) {
  const { slug } = await params;
  const body = await req.json();
  try {
    const note = await writeNote({
      path: pathFromSlug(slug),
      body: typeof body.body === "string" ? body.body : "",
      frontmatter: body.frontmatter ?? {},
    });
    return NextResponse.json(note);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { slug } = await params;
  try {
    await deleteNote(pathFromSlug(slug));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
