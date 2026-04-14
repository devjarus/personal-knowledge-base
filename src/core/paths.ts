import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * Resolve where the KB lives on disk.
 *
 * Resolution order (FR-1):
 *   1. KB_ROOT env var (resolved to absolute) — source: "env"
 *   2. kbRoot field in $XDG_CONFIG_HOME/kb/config.json — source: "config"
 *   3. Walk-up from cwd looking for a ./kb/ directory — source: "walkup"
 *   4. Fallback: ./kb next to cwd (may not exist) — source: "fallback"
 *
 * The env var always wins. Config-file resolution uses statSync + readFileSync
 * with mtime-based cache invalidation so the function stays synchronous.
 */

export type KbRootSource = "env" | "config" | "walkup" | "fallback";

interface ResolvedKbRoot {
  path: string;
  source: KbRootSource;
}

/**
 * Module-scoped cache for the config-file resolution layer.
 * Env is re-read on every call (cheap; allows test overrides).
 * Walk-up result is stable (cwd doesn't change in a running process).
 * Config-file result is cached and invalidated when the file's mtime changes.
 */
interface CacheEntry {
  value: string;
  source: KbRootSource;
  /** mtime of the config file when this entry was populated; null = file was absent */
  configMtimeMs: number | null;
}

let _cache: CacheEntry | null = null;

/** Called by POST /api/config after a successful write to force immediate re-read. */
export function _invalidateCache(): void {
  _cache = null;
}

/**
 * Absolute path to the config file, honouring $XDG_CONFIG_HOME.
 * Uses os.homedir() (not $HOME) so it matches src/core/config.ts and
 * works even when HOME is unset. Keep this function in sync with the
 * writer-side helper in config.ts — if divergence is ever reintroduced,
 * a config written by the API will silently not be read here.
 */
function _configFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base =
    xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "kb", "config.json");
}

/**
 * Synchronously resolve the effective kbRoot together with its source layer.
 * All existing callers of kbRoot() keep working because kbRoot() delegates here.
 */
export function resolveKbRoot(): ResolvedKbRoot {
  // --- Layer 1: env var (always wins; no caching needed — cheap string check) ---
  if (process.env.KB_ROOT) {
    return { path: path.resolve(process.env.KB_ROOT), source: "env" };
  }

  // --- Layer 2: config file (cached, mtime-invalidated) ---
  const cfp = _configFilePath();
  let configMtimeMs: number | null = null;
  try {
    const st = fs.statSync(cfp);
    configMtimeMs = st.mtimeMs;
  } catch {
    // File absent or unreadable — configMtimeMs stays null
  }

  // Check if the cache is still valid
  const cacheValid =
    _cache !== null && _cache.configMtimeMs === configMtimeMs;

  if (cacheValid && _cache !== null) {
    return { path: _cache.value, source: _cache.source };
  }

  // Cache miss or mtime changed — (re)compute
  if (configMtimeMs !== null) {
    // File exists — try to parse
    try {
      const raw = fs.readFileSync(cfp, "utf8");
      const parsed = JSON.parse(raw) as { kbRoot?: string };
      if (typeof parsed.kbRoot === "string" && parsed.kbRoot.length > 0) {
        const resolved = path.resolve(parsed.kbRoot);
        _cache = { value: resolved, source: "config", configMtimeMs };
        return { path: resolved, source: "config" };
      }
    } catch (e: unknown) {
      // Unparseable config — fall through to walk-up
      console.error("[core/paths] config file parse error, falling back:", e);
    }
  }

  // --- Layers 3 + 4: walk-up then fallback ---
  // These are stable for the process lifetime (cwd doesn't change),
  // so cache under the current configMtimeMs (null = no config file).
  // Note: any cache hit for the current configMtimeMs was already handled
  // above in the `cacheValid` branch; we only reach this point when there
  // is no cache entry or the file's mtime changed.
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, "kb");
    try {
      if (fs.statSync(candidate).isDirectory()) {
        _cache = { value: candidate, source: "walkup", configMtimeMs };
        return { path: candidate, source: "walkup" };
      }
    } catch {
      // Not found at this level — continue
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Last resort: ./kb next to cwd, even if it doesn't exist yet.
  const fallback = path.resolve(process.cwd(), "kb");
  _cache = { value: fallback, source: "fallback", configMtimeMs };
  return { path: fallback, source: "fallback" };
}

/**
 * Return the effective KB root path.
 *
 * Signature is unchanged — still sync, still returns string.
 * All existing callers keep working without edits.
 */
export function kbRoot(): string {
  return resolveKbRoot().path;
}

/**
 * Convert a relative KB path (as stored in Note.path) to an absolute
 * filesystem path, rejecting traversal attempts.
 */
export function resolveNotePath(relPath: string): string {
  const root = kbRoot();
  const normalized = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  const abs = path.resolve(root, normalized);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error(`Refusing path traversal: ${relPath}`);
  }
  return abs;
}

/** Convert an absolute path back to a KB-relative path with forward slashes. */
export function toRelPath(absPath: string): string {
  const rel = path.relative(kbRoot(), absPath);
  return rel.split(path.sep).join("/");
}

/** Ensure a path ends in .md, defaulting if missing. */
export function withMarkdownExt(p: string): string {
  return p.endsWith(".md") ? p : `${p}.md`;
}
