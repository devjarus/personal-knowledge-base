/**
 * POST /api/import
 *
 * Thin wrapper around the core importNotes() function.
 * Structure mirrors src/app/api/sync/route.ts verbatim for the try/catch
 * error shape. 400-vs-500 classification is a prefix check on
 * err.message.startsWith("import:") — same pattern as sync's KB_S3_BUCKET check.
 */

import { NextResponse } from "next/server";
import path from "node:path";
import os from "node:os";
import { importNotes } from "@/core/import";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Parse JSON body
  let body: {
    source?: unknown;
    from?: unknown;
    to?: unknown;
    overwrite?: unknown;
    dryRun?: unknown;
    ignorePatterns?: unknown;
    selectedSources?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "import: invalid JSON body" },
      { status: 400 },
    );
  }

  // Validate required source field
  if (typeof body.source !== "string" || !body.source.trim()) {
    return NextResponse.json(
      { error: "import: source is required" },
      { status: 400 },
    );
  }

  // FR-12: server-side ~ expansion
  let source = body.source.trim();
  if (source === "~") {
    source = os.homedir();
  } else if (source.startsWith("~/")) {
    source = path.join(os.homedir(), source.slice(2));
  }

  // Parse optional from/to dates
  let fromDate: Date | undefined;
  let toDate: Date | undefined;

  if (body.from !== undefined && body.from !== "") {
    if (typeof body.from !== "string") {
      return NextResponse.json(
        { error: "import: invalid from/to date" },
        { status: 400 },
      );
    }
    fromDate = new Date(body.from);
    if (!Number.isFinite(fromDate.getTime())) {
      return NextResponse.json(
        { error: "import: invalid from/to date" },
        { status: 400 },
      );
    }
  }

  if (body.to !== undefined && body.to !== "") {
    if (typeof body.to !== "string") {
      return NextResponse.json(
        { error: "import: invalid from/to date" },
        { status: 400 },
      );
    }
    toDate = new Date(body.to);
    if (!Number.isFinite(toDate.getTime())) {
      return NextResponse.json(
        { error: "import: invalid from/to date" },
        { status: 400 },
      );
    }
  }

  // Validate optional ignorePatterns field (AC-R12)
  let ignorePatterns: string[] | undefined;
  if (body.ignorePatterns !== undefined) {
    if (
      !Array.isArray(body.ignorePatterns) ||
      !body.ignorePatterns.every((p) => typeof p === "string")
    ) {
      return NextResponse.json(
        { error: "import: ignorePatterns must be an array of strings" },
        { status: 400 },
      );
    }
    ignorePatterns = body.ignorePatterns as string[];
  }

  // Validate optional selectedSources field (AC-R15)
  let selectedSources: string[] | undefined;
  if (body.selectedSources !== undefined) {
    if (
      !Array.isArray(body.selectedSources) ||
      !body.selectedSources.every((s) => typeof s === "string")
    ) {
      return NextResponse.json(
        { error: "import: selectedSources must be an array of strings" },
        { status: 400 },
      );
    }
    selectedSources = body.selectedSources as string[];
  }

  // Call core — let it do all source validation (AC-19: CLI and API see
  // identical error messages because both go through the same core function).
  try {
    const plan = await importNotes({
      source,
      from: fromDate,
      to: toDate,
      overwrite: body.overwrite === false ? false : undefined,
      dryRun: body.dryRun === true,
      ignorePatterns,
      selectedSources,
    });
    return NextResponse.json(plan);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("import:")) {
      // User error (validation failure) → 400
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    // Unexpected internal error → 500, do not leak raw message to client
    console.error("[api/import]", e);
    return NextResponse.json(
      { error: "Internal error during import" },
      { status: 500 },
    );
  }
}
