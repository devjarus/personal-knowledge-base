/**
 * src/core/config.ts
 *
 * Thin module responsible for the persistent KB config file at
 * $XDG_CONFIG_HOME/kb/config.json (or ~/.config/kb/config.json).
 *
 * All filesystem ops are synchronous (readFileSync/statSync) except
 * writeConfig and validateKbRootPath which are async because they are
 * only called from POST /api/config — never from the hot path that
 * dozens of callers traverse.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Shape stored on disk. Unknown keys are preserved on write (forward-compat). */
interface ConfigFileShape {
  kbRoot?: string;
  [key: string]: unknown;
}

/**
 * System directories that must never be accepted as a KB root.
 * Small reject list per spec: at minimum "/" and "/etc".
 * macOS has /private/etc as the real path for /etc (symlink), so both are listed.
 * Adding /bin, /sbin, /usr, /dev, /proc, /sys covers the most dangerous Unix roots
 * without being so aggressive that we block legitimate temp directories.
 */
const REJECTED_PATHS = new Set([
  "/",
  "/etc",
  "/private/etc",
  "/bin",
  "/sbin",
  "/usr",
  "/dev",
  "/proc",
  "/sys",
]);

/** Absolute path to the config file, honouring $XDG_CONFIG_HOME. */
export function configFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "kb", "config.json");
}

/**
 * Read the config file synchronously.
 * Returns null if the file is missing or unparseable — never throws for ENOENT.
 */
export function readConfigSync(): { kbRoot?: string } | null {
  const cfp = configFilePath();
  try {
    const raw = fs.readFileSync(cfp, "utf8");
    const parsed = JSON.parse(raw) as ConfigFileShape;
    return parsed;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // Unparseable JSON — treat as absent so callers can fall through
    console.error("[core/config] config file unparseable, ignoring:", e);
    return null;
  }
}

/**
 * Write a new config value atomically.
 * Unknown keys present in the existing file are preserved (forward-compat).
 * Writes to <path>.tmp then renames — POSIX rename is atomic on same FS.
 */
export async function writeConfig(next: { kbRoot: string }): Promise<void> {
  const cfp = configFilePath();
  const tmpPath = cfp + ".tmp";

  // Ensure parent directory exists
  await fsp.mkdir(path.dirname(cfp), { recursive: true });

  // Merge with existing unknown keys for forward-compat
  let existing: ConfigFileShape = {};
  try {
    const raw = await fsp.readFile(cfp, "utf8");
    existing = JSON.parse(raw) as ConfigFileShape;
  } catch {
    // Missing or unparseable — start fresh, no existing keys to preserve
  }

  const merged: ConfigFileShape = { ...existing, kbRoot: next.kbRoot };
  await fsp.writeFile(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  await fsp.rename(tmpPath, cfp);
}

/**
 * Validate a candidate KB root path.
 * Throws a `paths:`-prefixed Error on any violation.
 * Returns { canonical } — the fs.realpath-resolved path — on success.
 */
export async function validateKbRootPath(p: string): Promise<{ canonical: string }> {
  // 1. Must be absolute
  if (!path.isAbsolute(p)) {
    throw new Error(`paths: path must be absolute, got: ${p}`);
  }

  // 2. Must not be a known system directory
  if (REJECTED_PATHS.has(p)) {
    throw new Error(`paths: refusing to use system directory as KB root: ${p}`);
  }

  // 3. Resolve symlinks to get canonical path
  let canonical: string;
  try {
    canonical = await fsp.realpath(p);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`paths: path does not exist: ${p}`);
    }
    throw new Error(`paths: cannot resolve path: ${p} (${String(e)})`);
  }

  // 4. Canonical path must also not be a system directory
  if (REJECTED_PATHS.has(canonical)) {
    throw new Error(`paths: refusing to use system directory as KB root: ${canonical}`);
  }

  // 5. Must be a directory
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(canonical);
  } catch {
    throw new Error(`paths: path does not exist after canonicalization: ${canonical}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`paths: path is not a directory: ${canonical}`);
  }

  // 6. Must be readable and writable
  try {
    await fsp.access(canonical, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`paths: path is not readable/writable: ${canonical}`);
  }

  return { canonical };
}

/**
 * Invalidate the kbRoot() resolver cache.
 * Imported and called by the POST /api/config handler after a successful write
 * so that subsequent kbRoot() calls in the same Next.js process immediately
 * pick up the new value without waiting for the mtime check.
 *
 * Note: We import directly from paths.ts here. paths.ts does NOT import
 * config.ts, so there is no circular dependency. The re-export is purely
 * for convenience so callers can get everything they need from config.ts.
 */
export { _invalidateCache as invalidateCache } from "./paths";
