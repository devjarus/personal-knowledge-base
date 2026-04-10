import { NextResponse } from "next/server";
import { sync } from "@/core/sync";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: {
    direction?: "push" | "pull" | "both";
    mirror?: boolean;
    dryRun?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }

  try {
    const result = await sync({
      direction: body.direction ?? "both",
      mirror: body.mirror,
      dryRun: body.dryRun,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("KB_S3_BUCKET")) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
