"use client";

/**
 * OrganizeForm — MVP UI for `kb organize`.
 *
 * Three actions: Preview (dry-run), Apply (execute), Undo (reverse last apply).
 * No tuning controls in v1 — uses the same defaults as the CLI.
 *
 * Data flow:
 *   1. Preview  → POST /api/organize/plan  → stores OrganizePlan in state.
 *   2. Apply    → POST /api/organize/apply with the stored plan → ApplyResult.
 *   3. Undo     → POST /api/organize/undo                       → UndoResult.
 *
 * Uses the F2 error-parsing pattern from sync-button.tsx / import-form.tsx
 * to surface core-layer messages as toasts (load-bearing; do not simplify).
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowRight,
  Eye,
  FolderSymlink,
  Loader2,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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

import type { OrganizePlan, OrganizeMove } from "@/core/organize";

// ---------------------------------------------------------------------------
// Result types (mirror core/organize.ts — duplicated here to avoid pulling
// Node imports into the client bundle, per the import-form.tsx pattern).
// ---------------------------------------------------------------------------

interface ApplyResult {
  applied: number;
  ledgerPath: string;
  skipped: OrganizeMove[];
}

interface UndoResult {
  reverted: number;
  ledgerPath: string;
  conflicts: { path: string; reason: string }[];
}

type LoadingState = "idle" | "preview" | "apply" | "undo";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * F2 error-parser — DO NOT SIMPLIFY.
 *
 * Parses a failing Response. Extracts `.error` from JSON if present, falls
 * back to raw body text. This matches the pattern in sync-button.tsx and
 * import-form.tsx so core-layer error messages surface cleanly.
 */
async function parseError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const json = JSON.parse(text) as { error?: string };
    return json.error ?? text;
  } catch {
    return text;
  }
}

/** Group moves by the first segment of the target path. */
function groupByTargetFolder(
  moves: OrganizeMove[],
): Map<string, OrganizeMove[]> {
  const byFolder = new Map<string, OrganizeMove[]>();
  for (const m of moves) {
    const folder = m.to.split("/")[0] ?? m.to;
    const existing = byFolder.get(folder) ?? [];
    existing.push(m);
    byFolder.set(folder, existing);
  }
  return byFolder;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OrganizeForm() {
  const router = useRouter();

  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [lastApply, setLastApply] = useState<ApplyResult | null>(null);
  const [lastUndo, setLastUndo] = useState<UndoResult | null>(null);
  const [loading, setLoading] = useState<LoadingState>("idle");

  const [applyOpen, setApplyOpen] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);

  // Naming options (optional — defaults match the CLI).
  // useOllama=true means try Ollama first (three-tier fallback: Ollama → Flan-T5 → TF-IDF).
  // useLlm=false disables all LLM naming and goes straight to TF-IDF.
  const [useLlm, setUseLlm] = useState(true);
  const [useOllama, setUseOllama] = useState(true);
  const [ollamaModel, setOllamaModel] = useState("llama3.2");
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");

  const busy = loading !== "idle";

  // -------------------------------------------------------------------------
  // Fetch handlers
  // -------------------------------------------------------------------------

  async function handlePreview() {
    setLoading("preview");
    try {
      const res = await fetch("/api/organize/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          noLlm: !useLlm,
          noOllama: !useOllama,
          ollamaModel: ollamaModel.trim() || undefined,
          ollamaUrl: ollamaUrl.trim() || undefined,
        }),
      });
      if (!res.ok) {
        toast.error(await parseError(res));
        return;
      }
      const newPlan = (await res.json()) as OrganizePlan;
      setPlan(newPlan);
      // Clear stale apply/undo banners — they refer to an earlier run.
      setLastApply(null);
      setLastUndo(null);
      if (newPlan.moves.length === 0) {
        toast("Nothing to organize — your notes are already tidy.");
      } else {
        toast.success(
          `Preview ready: ${newPlan.moves.length} planned move${
            newPlan.moves.length === 1 ? "" : "s"
          }.`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading("idle");
    }
  }

  async function handleApplyConfirm() {
    if (!plan) return;
    setApplyOpen(false);
    setLoading("apply");
    try {
      const res = await fetch("/api/organize/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (!res.ok) {
        toast.error(await parseError(res));
        return;
      }
      const result = (await res.json()) as ApplyResult;
      setLastApply(result);
      setLastUndo(null);
      // Plan is stale after apply — force a fresh preview before re-applying.
      setPlan(null);
      toast.success(
        `Applied ${result.applied} move${result.applied === 1 ? "" : "s"}${
          result.skipped.length > 0
            ? ` (${result.skipped.length} skipped — content changed since preview)`
            : ""
        }.`,
      );
      // Refresh server components so the sidebar tree reflects the new layout.
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading("idle");
    }
  }

  async function handleUndoConfirm() {
    setUndoOpen(false);
    setLoading("undo");
    try {
      const res = await fetch("/api/organize/undo", { method: "POST" });
      if (!res.ok) {
        toast.error(await parseError(res));
        return;
      }
      const result = (await res.json()) as UndoResult;
      setLastUndo(result);
      setLastApply(null);
      setPlan(null);
      toast.success(
        `Reverted ${result.reverted} move${result.reverted === 1 ? "" : "s"}${
          result.conflicts.length > 0
            ? ` (${result.conflicts.length} conflict${result.conflicts.length === 1 ? "" : "s"})`
            : ""
        }.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading("idle");
    }
  }

  // -------------------------------------------------------------------------
  // Derived data for the preview block
  // -------------------------------------------------------------------------

  const grouped = useMemo(
    () => (plan ? groupByTargetFolder(plan.moves) : new Map()),
    [plan],
  );
  const rewriteFiles = useMemo(
    () => (plan ? new Set(plan.rewrites.map((r) => r.file)).size : 0),
    [plan],
  );

  const canApply = plan !== null && plan.moves.length > 0 && !busy;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Naming options */}
      <details className="rounded-md border p-3 text-sm [&[open]>summary]:mb-3">
        <summary className="cursor-pointer select-none text-sm font-medium">
          Naming options
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {useLlm
              ? useOllama
                ? `Ollama (${ollamaModel || "llama3.2"}) → Flan-T5 → TF-IDF`
                : "Flan-T5 → TF-IDF"
              : "TF-IDF only"}
          </span>
        </summary>
        <div className="space-y-3">
          <label className="flex items-start gap-2">
            <Checkbox
              checked={useLlm}
              onCheckedChange={(v) => setUseLlm(v === true)}
              disabled={busy}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div className="font-medium">Use LLM for folder names</div>
              <div className="text-xs text-muted-foreground">
                Uncheck to skip all LLM naming and fall back to deterministic
                TF-IDF keywords (fast, offline, no Ollama required).
              </div>
            </div>
          </label>
          <label className="flex items-start gap-2">
            <Checkbox
              checked={useOllama}
              onCheckedChange={(v) => setUseOllama(v === true)}
              disabled={busy || !useLlm}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div className="font-medium">Try Ollama first</div>
              <div className="text-xs text-muted-foreground">
                When enabled, queries a local Ollama server for higher-quality
                folder names. Falls back to Flan-T5 (then TF-IDF) if Ollama is
                unreachable or the model is missing.
              </div>
            </div>
          </label>
          <div className="grid gap-3 sm:grid-cols-2 pl-6">
            <div className="space-y-1">
              <label htmlFor="ollama-model" className="text-xs font-medium">
                Ollama model
              </label>
              <Input
                id="ollama-model"
                value={ollamaModel}
                onChange={(e) => setOllamaModel(e.target.value)}
                placeholder="llama3.2"
                disabled={busy || !useLlm || !useOllama}
              />
              <p className="text-[11px] text-muted-foreground">
                Prefix-matches installed variants (e.g. <code>llama3.2</code>{" "}
                matches <code>llama3.2:latest</code>).
              </p>
            </div>
            <div className="space-y-1">
              <label htmlFor="ollama-url" className="text-xs font-medium">
                Ollama URL
              </label>
              <Input
                id="ollama-url"
                value={ollamaUrl}
                onChange={(e) => setOllamaUrl(e.target.value)}
                placeholder="http://localhost:11434"
                disabled={busy || !useLlm || !useOllama}
              />
              <p className="text-[11px] text-muted-foreground">
                Default: <code>http://localhost:11434</code>.
              </p>
            </div>
          </div>
        </div>
      </details>

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={handlePreview} disabled={busy}>
          {loading === "preview" ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Eye className="mr-2 h-4 w-4" />
          )}
          {loading === "preview" ? "Previewing…" : "Preview plan"}
        </Button>

        <Button
          type="button"
          onClick={() => setApplyOpen(true)}
          disabled={!canApply}
          variant="default"
        >
          {loading === "apply" ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <FolderSymlink className="mr-2 h-4 w-4" />
          )}
          {loading === "apply" ? "Applying…" : "Apply"}
        </Button>

        <Button
          type="button"
          variant="outline"
          onClick={() => setUndoOpen(true)}
          disabled={busy}
        >
          {loading === "undo" ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Undo2 className="mr-2 h-4 w-4" />
          )}
          {loading === "undo" ? "Undoing…" : "Undo last organize"}
        </Button>
      </div>

      {/* Apply-result banner */}
      {lastApply !== null && (
        <div className="rounded-md border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/50 p-4 text-sm">
          <div className="font-medium">
            Applied {lastApply.applied} move{lastApply.applied === 1 ? "" : "s"}.
          </div>
          {lastApply.skipped.length > 0 && (
            <div className="mt-2 text-muted-foreground">
              Skipped {lastApply.skipped.length} (content changed since
              preview).
            </div>
          )}
          <div className="mt-2 text-xs text-muted-foreground">
            Ledger:{" "}
            <code className="font-mono">{lastApply.ledgerPath}</code>
            . Use <em>Undo last organize</em> to reverse.
          </div>
        </div>
      )}

      {/* Undo-result banner */}
      {lastUndo !== null && (
        <div className="rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/50 p-4 text-sm">
          <div className="font-medium">
            Reverted {lastUndo.reverted} move
            {lastUndo.reverted === 1 ? "" : "s"}.
          </div>
          {lastUndo.conflicts.length > 0 && (
            <div className="mt-2 text-muted-foreground">
              {lastUndo.conflicts.length} conflict
              {lastUndo.conflicts.length === 1 ? "" : "s"} (files edited after
              apply — left in place):
              <ul className="mt-1 ml-4 list-disc">
                {lastUndo.conflicts.map((c, i) => (
                  <li key={i}>
                    <code className="font-mono">{c.path}</code> — {c.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Preview block */}
      {plan !== null && <PlanPreview plan={plan} grouped={grouped} rewriteFiles={rewriteFiles} />}

      {/* Confirmation dialogs */}
      <AlertDialog open={applyOpen} onOpenChange={setApplyOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply organize plan?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <div>
                  This will move {plan?.moves.length ?? 0} file
                  {plan?.moves.length === 1 ? "" : "s"} and rewrite{" "}
                  {plan?.rewrites.length ?? 0} link reference
                  {plan?.rewrites.length === 1 ? "" : "s"} across{" "}
                  {rewriteFiles} file{rewriteFiles === 1 ? "" : "s"}.
                </div>
                <div className="text-xs">
                  A ledger is written before any file is touched, so you can
                  undo with one click if something looks wrong.
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleApplyConfirm}>
              Apply
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={undoOpen} onOpenChange={setUndoOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo last organize?</AlertDialogTitle>
            <AlertDialogDescription>
              Reverses the most recent applied organize. Files edited after the
              apply will be left in their moved location and reported as
              conflicts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleUndoConfirm}>
              Undo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview sub-component
// ---------------------------------------------------------------------------

function PlanPreview({
  plan,
  grouped,
  rewriteFiles,
}: {
  plan: OrganizePlan;
  grouped: Map<string, OrganizeMove[]>;
  rewriteFiles: number;
}) {
  if (plan.moves.length === 0) {
    return (
      <div className="rounded-md border p-6 text-center text-muted-foreground">
        Nothing to organize — all your notes already live where they should.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Summary line */}
      <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
        <span>
          <strong className="text-foreground">{plan.stats.total}</strong> notes
          scanned
        </span>
        <Separator orientation="vertical" className="h-4" />
        <span>
          <Badge variant="secondary" className="mr-1">by type</Badge>
          {plan.stats.byType}
        </span>
        <span>
          <Badge variant="secondary" className="mr-1">by tag</Badge>
          {plan.stats.byTag}
        </span>
        <span>
          <Badge variant="secondary" className="mr-1">by cluster</Badge>
          {plan.stats.byCluster}
        </span>
        {plan.stats.unassigned > 0 && (
          <span>
            <Badge variant="outline" className="mr-1">unassigned</Badge>
            {plan.stats.unassigned}
          </span>
        )}
      </div>

      {/* Cluster overview */}
      {plan.clusters.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">Clusters</h2>
          <div className="space-y-1.5">
            {plan.clusters.map((cl) => (
              <div
                key={cl.folder}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <code className="font-mono text-xs rounded bg-muted px-1.5 py-0.5">
                  {cl.folder}/
                </code>
                <span className="text-muted-foreground">
                  {cl.memberCount} note{cl.memberCount === 1 ? "" : "s"}
                </span>
                {cl.topTerms.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    [{cl.topTerms.slice(0, 4).join(", ")}]
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Moves grouped by target folder */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          Planned moves ({plan.moves.length})
        </h2>
        <div className="space-y-3">
          {[...grouped.entries()].map(([folder, moves]) => (
            <FolderGroup key={folder} folder={folder} moves={moves} />
          ))}
        </div>
      </section>

      {/* Link rewrites line */}
      <div className="text-sm text-muted-foreground">
        Link rewrites: <strong className="text-foreground">{plan.rewrites.length}</strong>{" "}
        reference{plan.rewrites.length === 1 ? "" : "s"} across{" "}
        <strong className="text-foreground">{rewriteFiles}</strong> file
        {rewriteFiles === 1 ? "" : "s"} will be updated.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FolderGroup — collapsible list of moves for a single target folder
// ---------------------------------------------------------------------------

const MOVES_COLLAPSED_LIMIT = 6;

function FolderGroup({
  folder,
  moves,
}: {
  folder: string;
  moves: OrganizeMove[];
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? moves : moves.slice(0, MOVES_COLLAPSED_LIMIT);
  const hiddenCount = moves.length - shown.length;

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <code className="font-mono text-xs rounded bg-muted px-1.5 py-0.5">
            {folder}/
          </code>
          <span className="text-xs text-muted-foreground">
            {moves.length} move{moves.length === 1 ? "" : "s"}
          </span>
        </div>
        {hiddenCount > 0 && !expanded && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:underline"
            onClick={() => setExpanded(true)}
          >
            Show {hiddenCount} more
          </button>
        )}
        {expanded && moves.length > MOVES_COLLAPSED_LIMIT && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:underline"
            onClick={() => setExpanded(false)}
          >
            Collapse
          </button>
        )}
      </div>
      <ul className="mt-2 space-y-1">
        {shown.map((m) => (
          <li
            key={m.from}
            className="flex items-center gap-2 text-xs font-mono"
          >
            <span
              className="text-muted-foreground truncate max-w-[40%]"
              title={m.from}
            >
              {m.from}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="truncate flex-1" title={m.to}>
              {m.to}
            </span>
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {m.reason}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
