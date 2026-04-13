"use client";

import { useState, useEffect, useCallback } from "react";
import { Folder, FileText } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// Types (mirrors FsLsEntry / FsLsResponse in the route handler)
// ---------------------------------------------------------------------------

interface FsLsEntry {
  name: string;
  path: string;
  isDir: boolean;
  isFile: boolean;
  bytes: number;
  mtime: string;
}

interface FsLsResponse {
  cwd: string;
  parent: string | null;
  entries: FsLsEntry[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface FolderPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (absPath: string) => void;
  /** If provided, the picker starts here. Default: server returns $HOME. */
  initialPath?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " kB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Build breadcrumb segments from an absolute path.
 * Returns [{label, absPath}] starting from $HOME (rendered as "~").
 * `home` is the absolute home dir returned by the first /api/fs/ls call.
 */
function buildBreadcrumbs(
  cwd: string,
  home: string,
): { label: string; absPath: string }[] {
  const crumbs: { label: string; absPath: string }[] = [];

  // Start with home as "~"
  crumbs.push({ label: "~", absPath: home });

  if (cwd === home) return crumbs;

  // Everything after $HOME
  const rel = cwd.startsWith(home + "/") ? cwd.slice(home.length + 1) : null;
  if (!rel) return crumbs; // shouldn't happen — server rejects paths outside $HOME

  const parts = rel.split("/");
  let accumulated = home;
  for (const part of parts) {
    accumulated = accumulated + "/" + part;
    crumbs.push({ label: part, absPath: accumulated });
  }
  return crumbs;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FolderPickerDialog({
  open,
  onOpenChange,
  onSelect,
  initialPath,
}: FolderPickerDialogProps) {
  // null means "not yet loaded" — first load sends no path param → server returns $HOME
  const [cwd, setCwd] = useState<string | null>(initialPath ?? null);
  const [home, setHome] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsLsEntry[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Fetch helper — F2 error-parsing pattern (same as sync-button.tsx)
  // -------------------------------------------------------------------------

  const load = useCallback(
    async (p: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const url = new URL("/api/fs/ls", window.location.origin);
        if (p) url.searchParams.set("path", p);
        if (showHidden) url.searchParams.set("showHidden", "1");
        const res = await fetch(url.toString());
        if (!res.ok) {
          // F2 pattern: parse JSON error body, extract .error field
          const text = await res.text();
          try {
            const json = JSON.parse(text) as { error?: string };
            setError(json.error ?? text);
          } catch {
            // response wasn't JSON; fall back to raw text
            setError(text);
          }
          return;
        }
        const data = (await res.json()) as FsLsResponse;
        setCwd(data.cwd);
        setParent(data.parent);
        setEntries(data.entries);
        // Stash $HOME on first load (parent === null means we are at $HOME)
        if (data.parent === null && home === null) {
          setHome(data.cwd);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    // showHidden and home are captured; load re-creates when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showHidden, home],
  );

  // -------------------------------------------------------------------------
  // Effect: fetch when dialog opens or showHidden toggles
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (open) {
      load(cwd);
    }
    // We intentionally omit `cwd` from deps: we only re-load on open/showHidden.
    // Navigation calls load() directly with the new path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showHidden]);

  // -------------------------------------------------------------------------
  // Breadcrumbs
  // -------------------------------------------------------------------------

  const breadcrumbs =
    cwd && home ? buildBreadcrumbs(cwd, home) : cwd ? [{ label: cwd, absPath: cwd }] : [];

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Select source folder</DialogTitle>
          <DialogDescription>
            Browse your home directory and click a folder to navigate. Click
            &ldquo;Select this folder&rdquo; to use the current directory as the
            import source.
          </DialogDescription>
        </DialogHeader>

        {/* Path row: breadcrumb + hidden toggle */}
        <div className="flex items-center justify-between gap-2 py-1 border-b">
          {/* title={cwd} on the breadcrumb container shows full absolute path on hover (FR-R11) */}
          <div
            className="flex items-center gap-0.5 flex-wrap text-sm font-mono"
            title={cwd ?? undefined}
          >
            {breadcrumbs.map((crumb, i) => (
              <span key={crumb.absPath} className="flex items-center">
                {i > 0 && <span className="text-muted-foreground px-0.5">/</span>}
                <button
                  type="button"
                  onClick={() => load(crumb.absPath)}
                  className={
                    i === breadcrumbs.length - 1
                      ? "font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Checkbox
              id="picker-show-hidden"
              checked={showHidden}
              onCheckedChange={(checked) => setShowHidden(checked === true)}
            />
            <label
              htmlFor="picker-show-hidden"
              className="text-xs text-muted-foreground cursor-pointer select-none"
            >
              Show hidden
            </label>
          </div>
        </div>

        {/* Scrollable entry list */}
        <div className="h-[400px] overflow-y-auto border rounded-md">
          {loading ? (
            <p className="p-6 text-center text-muted-foreground">Loading…</p>
          ) : error ? (
            <p className="p-6 text-center text-destructive">{error}</p>
          ) : entries.length === 0 ? (
            <p className="p-6 text-center text-muted-foreground">
              (empty folder)
            </p>
          ) : (
            <ul className="divide-y">
              {entries.map((entry) =>
                entry.isDir ? (
                  /* Directory row — clickable, navigates into it */
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() => load(entry.path)}
                      title={entry.path}
                      className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-muted/50 transition-colors"
                    >
                      <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium flex-1 break-all">
                        {entry.name}
                      </span>
                    </button>
                  </li>
                ) : (
                  /* File row — display-only, NOT interactive */
                  <li
                    key={entry.path}
                    title={entry.path}
                    className="flex items-center gap-3 px-4 py-2 text-muted-foreground"
                  >
                    <FileText className="h-4 w-4 shrink-0" />
                    <span className="text-sm flex-1 break-all">{entry.name}</span>
                    <span className="text-xs shrink-0">
                      {formatBytes(entry.bytes)}
                    </span>
                    <span className="text-xs shrink-0">
                      {new Date(entry.mtime).toLocaleDateString()}
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="flex-row items-center justify-between sm:justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={parent === null}
            onClick={() => {
              if (parent !== null) load(parent);
            }}
          >
            Up
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={cwd === null}
              title={cwd ?? undefined}
              onClick={() => {
                if (cwd !== null) {
                  onSelect(cwd);
                  onOpenChange(false);
                }
              }}
            >
              Select this folder
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
