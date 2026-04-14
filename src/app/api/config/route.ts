/**
 * GET /api/config  — returns the effective KB root and its resolution source.
 * POST /api/config — validates, writes, and invalidates cache; returns updated GET payload.
 *
 * Error shape mirrors AGENTS.md pattern:
 *   "paths:"-prefixed messages → HTTP 400
 *   anything else → HTTP 500 with scrubbed message
 */

import { NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveKbRoot } from "@/core/paths";
import {
  configFilePath,
  readConfigSync,
  writeConfig,
  validateKbRootPath,
  invalidateCache,
} from "@/core/config";
import { listNotes } from "@/core/fs";

export const dynamic = "force-dynamic";

interface ConfigPayload {
  kbRoot: string;
  source: "env" | "config" | "walkup" | "fallback";
  envKbRoot: string | null;
  configFilePath: string;
  configFileExists: boolean;
  savedKbRoot: string | null;
  noteCount: number;
  /** Present only on POST when env is active, to warn the client */
  envOverrideHint?: string;
}

async function buildPayload(): Promise<ConfigPayload> {
  const { path: kbRootPath, source } = resolveKbRoot();
  const cfp = configFilePath();
  const envKbRoot = process.env.KB_ROOT ? path.resolve(process.env.KB_ROOT) : null;

  // Check if config file exists
  let configFileExists = false;
  try {
    await fsp.access(cfp);
    configFileExists = true;
  } catch {
    // File absent — expected when not yet configured
  }

  // Read saved value from file regardless of which source is active
  const configData = readConfigSync();
  const savedKbRoot = configData?.kbRoot ?? null;

  // Count notes under effective root (cheap — reuses existing listNotes)
  let noteCount = 0;
  try {
    const notes = await listNotes();
    noteCount = notes.length;
  } catch {
    // If the KB root doesn't exist yet, note count is 0 — not a fatal error
  }

  return {
    kbRoot: kbRootPath,
    source,
    envKbRoot,
    configFilePath: cfp,
    configFileExists,
    savedKbRoot,
    noteCount,
  };
}

export async function GET() {
  try {
    const payload = await buildPayload();
    return NextResponse.json(payload);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/config] GET error:", e);
    return NextResponse.json({ error: `Internal error: ${msg}` }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: { kbRoot?: unknown } = {};
  try {
    body = (await req.json()) as { kbRoot?: unknown };
  } catch {
    return NextResponse.json(
      { error: "paths: request body must be JSON with a kbRoot field" },
      { status: 400 },
    );
  }

  const rawPath = body.kbRoot;
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return NextResponse.json(
      { error: "paths: kbRoot must be a non-empty string" },
      { status: 400 },
    );
  }

  try {
    // Validate and canonicalize
    const { canonical } = await validateKbRootPath(rawPath.trim());

    // Write atomically
    await writeConfig({ kbRoot: canonical });

    // Explicitly invalidate the in-process cache so the next kbRoot() call
    // returns the new value without waiting for the mtime check.
    invalidateCache();

    // Build updated payload
    const payload = await buildPayload();

    // If env is active, the saved value won't be used — warn the client
    if (process.env.KB_ROOT) {
      const result: ConfigPayload = {
        ...payload,
        envOverrideHint:
          "Your new path has been saved to the config file, but KB_ROOT environment variable is currently set and takes priority. Remove KB_ROOT to use the config file value.",
      };
      return NextResponse.json(result);
    }

    return NextResponse.json(payload);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("paths:")) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error("[api/config] POST error:", e);
    return NextResponse.json(
      { error: `Internal error saving config: ${msg}` },
      { status: 500 },
    );
  }
}
