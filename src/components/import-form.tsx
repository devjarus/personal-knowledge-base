"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpDown, ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { FolderPickerDialog } from "@/components/folder-picker-dialog";
import type { ImportPlan } from "@/core/import";

// Mirrors DEFAULT_IGNORE_PATTERNS in src/core/import.ts. Duplicated here
// to avoid pulling the core module (and its Node imports) into the
// client bundle. Keep in sync.
const DEFAULT_IGNORE_PATTERNS = [
  ".*",
  "node_modules",
  "*.bak",
  "*.tmp",
  "*.swp",
  "*~",
] as const;

// ---------------------------------------------------------------------------
// Sort types and helpers
// ---------------------------------------------------------------------------

type SortKey = "source" | "target" | "date" | "status" | "bytes";
type SortDir = "asc" | "desc";

const STATUS_ORDER: Record<string, number> = {
  plan: 0,
  "skip-exists": 1,
  "skip-filter": 2,
  "skip-ignored": 3,
  "skip-unselected": 4,
};

function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " kB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function parseIgnoreText(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 hover:text-foreground"
    >
      {label}
      {active ? (
        dir === "asc" ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )
      ) : (
        <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export default function ImportForm() {
  const router = useRouter();
  const [source, setSource] = useState("");
  const [from, setFrom] = useState(""); // yyyy-mm-dd or ""
  const [to, setTo] = useState(""); // yyyy-mm-dd or ""
  const [overwrite, setOverwrite] = useState(true); // FR-13: default checked
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [loading, setLoading] = useState<"idle" | "preview" | "import">("idle");
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Picker state
  const [pickerOpen, setPickerOpen] = useState(false);
  // Ignore patterns
  const [ignoreText, setIgnoreText] = useState(
    DEFAULT_IGNORE_PATTERNS.join("\n"),
  );
  const [ignoreExpanded, setIgnoreExpanded] = useState(false);
  // Sort state
  const [sortKey, setSortKey] = useState<SortKey>("source");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // Per-row selection — keyed by sourceAbs (AC-R14: default all plan entries selected)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Table pagination — show first 200 rows by default to avoid DOM jank on
  // large plans. Master checkbox and selection counts cover ALL entries, not
  // just the visible slice. User can expand to see everything with one click.
  const [showAll, setShowAll] = useState(false);

  // -------------------------------------------------------------------------
  // Fetch helper — F2 error-parsing pattern (load-bearing; must not simplify)
  // -------------------------------------------------------------------------

  async function callImport(dryRun: boolean): Promise<ImportPlan | null> {
    try {
      setLoading(dryRun ? "preview" : "import");
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: source.trim(),
          from: from || undefined,
          to: to || undefined,
          overwrite,
          dryRun,
          ignorePatterns: parseIgnoreText(ignoreText),
          // On real import, send the selected subset (AC-R15).
          // On dry-run, omit — dry-run never writes, selection is UI-only.
          ...(!dryRun && { selectedSources: Array.from(selectedKeys) }),
        }),
      });
      if (!res.ok) {
        // F2 pattern — DO NOT SIMPLIFY
        // Parse JSON error body; extract .error field; fall back to raw text.
        // This matches sync-button.tsx and note-editor.tsx verbatim.
        const text = await res.text();
        try {
          const json = JSON.parse(text) as { error?: string };
          toast.error(json.error ?? text);
        } catch {
          // response wasn't JSON; fall back to raw text
          toast.error(text);
        }
        return null;
      }
      return (await res.json()) as ImportPlan;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading("idle");
    }
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  async function handlePreview() {
    if (!source.trim()) {
      toast.error("Source folder is required");
      return;
    }
    const p = await callImport(true);
    if (p) {
      setPlan(p);
      setShowAll(false); // reset pagination on new plan
      // AC-R14: default all plan-status entries selected on new dry-run result
      setSelectedKeys(
        new Set(
          p.entries
            .filter((e) => e.status === "plan")
            .map((e) => e.sourceAbs),
        ),
      );
    }
  }

  async function handleImportConfirm() {
    setConfirmOpen(false);
    const p = await callImport(false);
    if (p) {
      toast.success(`${p.counts.planned} files imported`);
      setPlan(p); // update counts to reflect execution result
      // Do NOT re-initialize selectedKeys after import (post-import plan may
      // have skip-unselected rows which are no longer actionable).
      // Invalidate the server-component cache so the sidebar tree and home
      // page reflect the newly imported notes without a manual page reload.
      router.refresh();
    }
  }

  // -------------------------------------------------------------------------
  // Sort helpers
  // -------------------------------------------------------------------------

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sortedEntries = useMemo(() => {
    if (!plan) return [];
    const copy = [...plan.entries];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "source":
          cmp = a.sourceRel.localeCompare(b.sourceRel);
          break;
        case "target":
          cmp = a.targetRel.localeCompare(b.targetRel);
          break;
        case "date":
          cmp = Date.parse(a.resolvedDate) - Date.parse(b.resolvedDate);
          break;
        case "status":
          cmp =
            (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
          break;
        case "bytes":
          cmp = a.bytes - b.bytes;
          break;
      }
      // Stable tie-break on sourceRel ascending
      if (cmp === 0) cmp = a.sourceRel.localeCompare(b.sourceRel);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [plan, sortKey, sortDir]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Derived selection counts (AC-R14)
  const planEntries = useMemo(
    () => (plan ? plan.entries.filter((e) => e.status === "plan") : []),
    [plan],
  );
  const totalPlanCount = planEntries.length;
  const selectedCount = planEntries.filter((e) =>
    selectedKeys.has(e.sourceAbs),
  ).length;

  // Master checkbox state: true=all selected, false=none, "indeterminate"=partial
  const masterChecked: boolean | "indeterminate" =
    totalPlanCount === 0
      ? false
      : selectedCount === totalPlanCount
        ? true
        : selectedCount === 0
          ? false
          : "indeterminate";

  function handleMasterCheck() {
    if (selectedCount === totalPlanCount) {
      // All selected → deselect all
      setSelectedKeys(new Set());
    } else {
      // None or partial → select all
      setSelectedKeys(new Set(planEntries.map((e) => e.sourceAbs)));
    }
  }

  function handleRowCheck(sourceAbs: string, checked: boolean) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(sourceAbs);
      } else {
        next.delete(sourceAbs);
      }
      return next;
    });
  }

  // Import button is enabled only if at least one plan entry is selected.
  const canImport = plan !== null && selectedCount > 0;

  return (
    <div className="space-y-6">
      {/* Form fields */}
      <div className="space-y-4">
        {/* Source folder */}
        <div className="space-y-1.5">
          <label className="text-sm text-muted-foreground" htmlFor="import-source">
            Source folder
          </label>
          <div className="flex gap-2">
            <Input
              id="import-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="~/Documents/obsidian-vault"
              className="flex-1 font-mono text-sm"
              title={source || undefined}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => setPickerOpen(true)}
            >
              Browse…
            </Button>
          </div>
        </div>

        {/* Date range */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground" htmlFor="import-from">
              From
            </label>
            <Input
              id="import-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground" htmlFor="import-to">
              To
            </label>
            <Input
              id="import-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="text-sm"
            />
          </div>
        </div>

        {/* Overwrite checkbox */}
        <div className="flex items-center gap-2">
          <Checkbox
            id="import-overwrite"
            checked={overwrite}
            onCheckedChange={(checked) => setOverwrite(checked === true)}
          />
          <label
            htmlFor="import-overwrite"
            className="text-sm cursor-pointer select-none"
          >
            Overwrite existing files (re-imports update in place)
          </label>
        </div>

        {/* Ignore patterns (collapsible) */}
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setIgnoreExpanded((v) => !v)}
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            {ignoreExpanded ? "▾" : "▸"} Ignore patterns
          </button>
          {ignoreExpanded && (
            <div className="space-y-2">
              <Textarea
                value={ignoreText}
                onChange={(e) => setIgnoreText(e.target.value)}
                rows={6}
                className="font-mono text-xs"
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  One pattern per line. <code>*.bak</code> matches suffixes,{" "}
                  <code>foo</code> matches exact segments,{" "}
                  <code>.*</code> matches dotfiles. <code>#</code> starts a
                  comment.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    setIgnoreText(DEFAULT_IGNORE_PATTERNS.join("\n"))
                  }
                  className="text-xs text-muted-foreground hover:underline shrink-0 ml-2"
                >
                  Restore defaults
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            type="button"
            onClick={handlePreview}
            disabled={loading !== "idle"}
          >
            {loading === "preview" ? "Previewing…" : "Preview"}
          </Button>

          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                disabled={!canImport || loading !== "idle"}
                onClick={() => setConfirmOpen(true)}
              >
                {loading === "import" ? "Importing…" : "Import"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Confirm import</AlertDialogTitle>
                <AlertDialogDescription>
                  Import {selectedCount} of {totalPlanCount} files into{" "}
                  <code className="font-mono text-xs">{plan?.targetPrefix}</code>?
                  This will{" "}
                  {overwrite
                    ? "overwrite any existing files at the target paths."
                    : "skip existing files."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleImportConfirm}>
                  Continue
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Live selection count and hint */}
          {plan !== null && totalPlanCount > 0 && (
            <span className="text-sm text-muted-foreground">
              {selectedCount === 0 ? (
                <span className="text-destructive">
                  Select at least one file
                </span>
              ) : (
                <>Import {selectedCount} of {totalPlanCount} planned</>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Preview table */}
      {plan !== null && (
        <div className="space-y-3">
          {/* Summary counts header */}
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {plan.counts.planned}
            </span>{" "}
            planned ·{" "}
            <span className="font-medium text-foreground">
              {plan.counts.skippedExists}
            </span>{" "}
            skipped (exists) ·{" "}
            <span className="font-medium text-foreground">
              {plan.counts.skippedFilter}
            </span>{" "}
            skipped (filter) ·{" "}
            <span className="font-medium text-foreground">
              {plan.counts.skippedIgnored}
            </span>{" "}
            ignored
            {plan.counts.skippedUnselected > 0 && (
              <>
                {" "}·{" "}
                <span className="font-medium text-foreground">
                  {plan.counts.skippedUnselected}
                </span>{" "}
                deselected
              </>
            )}
          </p>

          {sortedEntries.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              No files match. Adjust the source path or time window.
            </p>
          ) : (
            <>
              {/* Pagination header — only shown when there are more than 200 rows */}
              {sortedEntries.length > 200 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>
                    {showAll
                      ? `Showing all ${sortedEntries.length} entries`
                      : `Showing 200 of ${sortedEntries.length} entries`}
                  </span>
                  {!showAll && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowAll(true)}
                    >
                      Show all {sortedEntries.length} entries
                    </Button>
                  )}
                </div>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    {/* Checkbox column — master select/deselect (covers ALL entries, not just visible) */}
                    <TableHead className="w-8">
                      <Checkbox
                        checked={masterChecked}
                        onCheckedChange={handleMasterCheck}
                        aria-label="Select all plan entries"
                      />
                    </TableHead>
                    <TableHead>
                      <SortHeader
                        label="Source"
                        active={sortKey === "source"}
                        dir={sortDir}
                        onClick={() => handleSort("source")}
                      />
                    </TableHead>
                    <TableHead>
                      <SortHeader
                        label="→ Target"
                        active={sortKey === "target"}
                        dir={sortDir}
                        onClick={() => handleSort("target")}
                      />
                    </TableHead>
                    <TableHead>
                      <SortHeader
                        label="Date"
                        active={sortKey === "date"}
                        dir={sortDir}
                        onClick={() => handleSort("date")}
                      />
                    </TableHead>
                    <TableHead>
                      <SortHeader
                        label="Status"
                        active={sortKey === "status"}
                        dir={sortDir}
                        onClick={() => handleSort("status")}
                      />
                    </TableHead>
                    <TableHead>
                      <SortHeader
                        label="Bytes"
                        active={sortKey === "bytes"}
                        dir={sortDir}
                        onClick={() => handleSort("bytes")}
                      />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(showAll ? sortedEntries : sortedEntries.slice(0, 200)).map((entry, i) => (
                    <TableRow key={i}>
                      {/* Checkbox cell — only plan entries get an active checkbox */}
                      <TableCell className="w-8">
                        {entry.status === "plan" ? (
                          <Checkbox
                            checked={selectedKeys.has(entry.sourceAbs)}
                            onCheckedChange={(checked) =>
                              handleRowCheck(entry.sourceAbs, checked === true)
                            }
                            aria-label={`Select ${entry.sourceRel}`}
                          />
                        ) : (
                          /* Non-plan rows: empty placeholder for visual alignment */
                          <span className="inline-block w-4 h-4" />
                        )}
                      </TableCell>
                      <TableCell>
                        {/* FR-R11: break-all + title tooltip; no truncation */}
                        <span
                          title={entry.sourceAbs}
                          className="font-mono text-xs break-all"
                        >
                          {entry.sourceRel}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          title={entry.targetRel}
                          className="font-mono text-xs break-all"
                        >
                          {entry.targetRel}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {entry.resolvedDate.slice(0, 10)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={entry.status} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatBytes(entry.bytes)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </div>
      )}

      {/* Folder picker dialog — controlled by pickerOpen state */}
      <FolderPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={(abs) => setSource(abs)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "plan":
      return <Badge variant="default">plan</Badge>;
    case "skip-exists":
      return <Badge variant="secondary">skip-exists</Badge>;
    case "skip-filter":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          skip-filter
        </Badge>
      );
    case "skip-ignored":
      return <Badge variant="outline">skip-ignored</Badge>;
    case "skip-unselected":
      return (
        <Badge variant="outline" className="text-muted-foreground opacity-60">
          skip-unselected
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}
