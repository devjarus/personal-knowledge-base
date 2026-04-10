import { NextResponse } from "next/server";
import { listNotes, writeNote } from "@/core/fs";

export const dynamic = "force-dynamic";

export async function GET() {
  const notes = await listNotes();
  return NextResponse.json(notes);
}

export async function POST(req: Request) {
  const body = await req.json();
  if (!body || typeof body.path !== "string") {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  try {
    const note = await writeNote({
      path: body.path,
      body: typeof body.body === "string" ? body.body : "",
      frontmatter: body.frontmatter ?? {},
    });
    return NextResponse.json(note, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
