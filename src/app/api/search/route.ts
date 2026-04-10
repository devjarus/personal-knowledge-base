import { NextResponse } from "next/server";
import { searchNotes } from "@/core/search";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(100, Number(limitRaw))) : 30;
  const hits = await searchNotes(q, limit);
  return NextResponse.json(hits);
}
