"use client";

/**
 * Client-side Miller-column browser with multi-select + bulk delete.
 *
 * Selection state lives here (not per-column) because a user can select
 * items across multiple columns. The server page feeds static column data;
 * this component owns:
 *   - Selection set (keyed by "<type>:<path>")
 *   - Entering/exiting "select mode"
 *   - Per-folder delete (column header trash)
 *   - Bulk delete (floating action bar when selection > 0)
 *
 * Deletes call `router.refresh()` after server response so the server-
 * component column data is re-fetched — no stale rows.
 */

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  Folder,
  FileText,
  Home,
  Trash2,
  X,
  CheckSquare,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/** Flat shape passed from the server page — matches core/types TreeNode. */
export interface BrowseChild {
  name: string;
  path: string;
  type: "file" | "directory";
}

export interface BrowseColumn {
  prefix: string;
  children: BrowseChild[];
  activeChildName: string | null;
}

interface SelectionKey {
  key: string;
  path: string;
  type: "file" | "folder";
}

function keyFor(child: BrowseChild): SelectionKey {
  const type: "file" | "folder" = child.type === "directory" ? "folder" : "file";
  return { key: `${type}:${child.path}`, path: child.path, type };
}

function Breadcrumb({ segments }: { segments: string[] }) {
  return (
    <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
      <Link
        href="/browse"
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <Home className="h-3.5 w-3.5" />
        <span>browse</span>
      </Link>
      {segments.map((seg, i) => {
        const href = `/browse/${segments.slice(0, i + 1).join("/")}`;
        const isLast = i === segments.length - 1;
        return (
          <span key={href} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            {isLast ? (
              <span className="font-medium">{seg}</span>
            ) : (
              <Link
                href={href}
                className="text-muted-foreground hover:text-foreground"
              >
                {seg}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export function BrowseView({
  columns,
  segments,
}: {
  columns: BrowseColumn[];
  segments: string[];
}) {
  const router = useRouter();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Map<string, SelectionKey>>(new Map());
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<{
    kind: "single-folder" | "single-file" | "bulk";
    items: SelectionKey[];
    label: string;
  } | null>(null);

  const selectedArr = useMemo(() => [...selected.values()], [selected]);

  function toggle(child: BrowseChild) {
    const k = keyFor(child);
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(k.key)) next.delete(k.key);
      else next.set(k.key, k);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Map());
  }

  function exitSelectMode() {
    setSelectMode(false);
    clearSelection();
  }

  async function performDelete(items: SelectionKey[]) {
    if (items.length === 0) return;
    try {
      const res = await fetch("/api/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map((i) => ({ path: i.path, type: i.type })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "delete failed");
        return;
      }
      const failures = (data.results ?? []).filter((r: { ok: boolean }) => !r.ok);
      if (failures.length > 0) {
        toast.warning(
          `Deleted ${data.totalNotes} notes. ${failures.length} item(s) failed.`,
        );
      } else {
        toast.success(`Deleted ${data.totalNotes} note${data.totalNotes === 1 ? "" : "s"}.`);
      }
      clearSelection();
      setSelectMode(false);
      startTransition(() => router.refresh());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function askDeleteFolder(prefix: string, count: number) {
    setConfirm({
      kind: "single-folder",
      items: [{ key: `folder:${prefix}`, path: prefix, type: "folder" }],
      label: `${prefix} (${count} item${count === 1 ? "" : "s"})`,
    });
  }

  function askDeleteBulk() {
    setConfirm({
      kind: "bulk",
      items: selectedArr,
      label: `${selectedArr.length} selected item${selectedArr.length === 1 ? "" : "s"}`,
    });
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Top bar: breadcrumb + select-mode toggle */}
      <div className="flex items-center gap-3 border-b border-border bg-muted/20 px-4 py-2">
        <Breadcrumb segments={segments} />
        {selectMode ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={exitSelectMode}
            className="gap-2"
          >
            <X className="h-4 w-4" />
            Done
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectMode(true)}
            className="gap-2"
          >
            <CheckSquare className="h-4 w-4" />
            Select
          </Button>
        )}
      </div>

      {/* Miller columns */}
      <div className="flex min-h-0 flex-1 overflow-x-auto">
        {columns.map((col, i) => (
          <ColumnView
            key={col.prefix || `col-${i}`}
            column={col}
            selectMode={selectMode}
            selected={selected}
            onToggle={toggle}
            onDeleteFolder={askDeleteFolder}
          />
        ))}
      </div>

      {/* Floating action bar */}
      {selectMode && selectedArr.length > 0 && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
          <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-2 shadow-lg">
            <span className="text-sm">
              <span className="font-medium">{selectedArr.length}</span> selected
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearSelection}
              className="gap-2"
            >
              <X className="h-4 w-4" />
              Clear
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={askDeleteBulk}
              disabled={pending}
              className="gap-2"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          </div>
        </div>
      )}

      {/* Confirm dialog (shared for single-folder and bulk) */}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirm?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes files from <code>KB_ROOT</code>. Can&apos;t be
              undone from here — use <code>git</code> or your backup if you need to
              recover.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                const items = confirm?.items ?? [];
                setConfirm(null);
                await performDelete(items);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ColumnView({
  column,
  selectMode,
  selected,
  onToggle,
  onDeleteFolder,
}: {
  column: BrowseColumn;
  selectMode: boolean;
  selected: Map<string, SelectionKey>;
  onToggle: (c: BrowseChild) => void;
  onDeleteFolder: (prefix: string, count: number) => void;
}) {
  const sorted = useMemo(() => {
    return [...column.children].sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [column.children]);

  return (
    <div className="flex h-full w-[280px] shrink-0 flex-col border-r border-border bg-background">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {column.prefix || "/"}
          <span className="ml-1 text-muted-foreground/70">
            ({sorted.length})
          </span>
        </span>
        {column.prefix && (
          <button
            type="button"
            onClick={() => onDeleteFolder(column.prefix, sorted.length)}
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title={`Delete folder ${column.prefix}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {sorted.length === 0 && (
          <li className="px-3 py-2 text-xs text-muted-foreground">(empty)</li>
        )}
        {sorted.map((child) => {
          const k = keyFor(child);
          const isSelected = selected.has(k.key);
          const isActive = child.name === column.activeChildName;

          // In select mode: clicking the row toggles selection (no navigation).
          // Out of select mode: row is a Link to the folder / note viewer.
          if (selectMode) {
            return (
              <li key={child.path}>
                <button
                  type="button"
                  onClick={() => onToggle(child)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                    isSelected
                      ? "bg-primary/15 text-foreground"
                      : "hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <Checkbox checked={isSelected} className="pointer-events-none" />
                  {child.type === "directory" ? (
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {child.type === "directory"
                      ? child.name
                      : child.name.replace(/\.md$/, "")}
                  </span>
                </button>
              </li>
            );
          }

          if (child.type === "directory") {
            const href = `/browse/${child.path}`;
            return (
              <li key={child.path}>
                <Link
                  href={href}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 text-sm transition-colors",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <Square className="invisible h-4 w-4" />
                  <Folder
                    className={cn(
                      "h-4 w-4 shrink-0",
                      isActive
                        ? "text-primary-foreground"
                        : "text-muted-foreground",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{child.name}</span>
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      isActive
                        ? "text-primary-foreground"
                        : "text-muted-foreground/70",
                    )}
                  />
                </Link>
              </li>
            );
          }

          const slug = child.path.replace(/\.md$/, "");
          return (
            <li key={child.path}>
              <Link
                href={`/notes/${slug}`}
                className="flex items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Square className="invisible h-4 w-4" />
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {child.name.replace(/\.md$/, "")}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
