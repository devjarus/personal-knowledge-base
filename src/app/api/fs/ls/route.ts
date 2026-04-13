/**
 * GET /api/fs/ls
 *
 * Server-driven filesystem browser for the folder picker UI.
 * Returns directory contents bounded to $HOME (never inside KB_ROOT).
 *
 * Security constraints:
 *   - Only paths equal to or under os.homedir() are allowed.
 *   - Paths inside KB_ROOT are rejected.
 *   - Symlinks are not followed (lstat used for hidden-check, stat for content).
 *   - No file contents are returned — only metadata.
 *
 * Error shape: { error: "import: ..." } at HTTP 400.
 * This mirrors POST /api/import so the UI's F2 parsing works unchanged.
 */

import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { kbRoot } from "@/core/paths";

export const dynamic = "force-dynamic";

interface FsLsEntry {
  name: string;
  path: string;
  isDir: boolean;
  isFile: boolean;
  bytes: number;
  mtime: string; // ISO
}

interface FsLsResponse {
  cwd: string;
  parent: string | null;
  entries: FsLsEntry[];
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  const showHidden = url.searchParams.get("showHidden") === "1";

  const home = os.homedir();
  // Empty string is falsy — treat same as omitted (fall back to $HOME).
  const resolvedInput = rawPath ? path.resolve(rawPath) : home;

  // 1) must be absolute (path.resolve always produces absolute; guard for clarity)
  if (!path.isAbsolute(resolvedInput)) {
    return NextResponse.json(
      { error: "import: path must be absolute" },
      { status: 400 },
    );
  }

  // 2) Resolve symlinks BEFORE the boundary checks so a symlink under $HOME
  //    pointing to /etc (or anywhere else) cannot escape the sandbox.
  //    Prior implementation used path.resolve alone, which does not follow
  //    symlinks — that allowed `$HOME/link-to-etc` to pass the $HOME prefix
  //    check and then fs.stat/readdir would happily descend into /etc.
  //    fs.realpath fully canonicalizes the path; we re-run all checks on it.
  let cwd: string;
  try {
    cwd = await fs.realpath(resolvedInput);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return NextResponse.json(
        { error: `import: path does not exist: ${resolvedInput}` },
        { status: 400 },
      );
    }
    console.error("[api/fs/ls] realpath error", e);
    return NextResponse.json(
      { error: "Internal error resolving path" },
      { status: 500 },
    );
  }

  // 2a) must be under $HOME (or equal to $HOME) — checked on the REAL path
  if (!(cwd === home || cwd.startsWith(home + path.sep))) {
    return NextResponse.json(
      { error: "import: path must be under $HOME" },
      { status: 400 },
    );
  }

  // 3) must NOT be inside KB_ROOT — also checked on the real path so a
  //    symlink like `$HOME/kb-link` → KB_ROOT is rejected.
  const kbAbs = await fs.realpath(path.resolve(kbRoot())).catch(() =>
    path.resolve(kbRoot()),
  );
  if (cwd === kbAbs || cwd.startsWith(kbAbs + path.sep)) {
    return NextResponse.json(
      { error: "import: path cannot be inside KB_ROOT" },
      { status: 400 },
    );
  }

  // 4) must exist and be a directory (use stat — we want to follow the final
  //    target so a symlink-to-dir is acceptable here, but we report the
  //    resolved type rather than "symlink").
  try {
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) {
      return NextResponse.json(
        { error: `import: path is not a directory: ${cwd}` },
        { status: 400 },
      );
    }
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return NextResponse.json(
        { error: `import: path does not exist: ${cwd}` },
        { status: 400 },
      );
    }
    console.error("[api/fs/ls] stat error", e);
    return NextResponse.json(
      { error: "Internal error listing directory" },
      { status: 500 },
    );
  }

  // 5) readdir + per-entry stat
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(cwd, { withFileTypes: true });
  } catch (e: unknown) {
    console.error("[api/fs/ls] readdir error", e);
    return NextResponse.json(
      { error: "Internal error reading directory" },
      { status: 500 },
    );
  }

  const entries: FsLsEntry[] = [];
  for (const d of dirents) {
    // Filter hidden unless showHidden=1
    if (!showHidden && d.name.startsWith(".")) continue;
    const abs = path.join(cwd, d.name);
    try {
      // Use stat (follows symlinks) so symlink-to-dir shows as isDir.
      // Broken symlinks will throw and be silently dropped below.
      const st = await fs.stat(abs);
      entries.push({
        name: d.name,
        path: abs,
        isDir: st.isDirectory(),
        isFile: st.isFile(),
        bytes: st.isDirectory() ? 0 : st.size,
        mtime: st.mtime.toISOString(),
      });
    } catch {
      // Skip entries we can't stat (broken symlinks, permission denied).
      // Intentionally swallowed: a single inaccessible entry should not
      // fail the whole listing.
      continue;
    }
  }

  // Sort: dirs first A-Z, then files A-Z (case-insensitive within group)
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Parent: null when at $HOME or when dirname equals self (filesystem root).
  // Also null if the computed parent would escape $HOME (safety net).
  const parentDir = path.dirname(cwd);
  const parent =
    cwd === home || parentDir === cwd || !parentDir.startsWith(home)
      ? null
      : parentDir;

  const body: FsLsResponse = { cwd, parent, entries };
  return NextResponse.json(body);
}
