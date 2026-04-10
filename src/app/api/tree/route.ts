import { NextResponse } from "next/server";
import { buildTree } from "@/core/fs";

export const dynamic = "force-dynamic";

export async function GET() {
  const tree = await buildTree();
  return NextResponse.json(tree);
}
