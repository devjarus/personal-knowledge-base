"use client";

/**
 * LearnForm — UI for `kb learn`.
 *
 * Three actions: Plan (dry-run), Apply (execute), Undo (reverse last apply).
 * Mirrors OrganizeForm structure and conventions end-to-end.
 *
 * Data flow:
 *   1. Plan   → POST /api/learn/plan  → stores LearnPlan in state.
 *   2. Apply  → POST /api/learn/apply with the stored plan → ApplyLearnResult.
 *   3. Undo   → POST /api/learn/undo                       → UndoLearnResult.
 *
 * Uses the F2 error-parsing pattern from organize-form.tsx (load-bearing; do
 * not simplify).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BookOpen, Eye, Loader2, Undo2 } from "lucide-react";

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ---------------------------------------------------------------------------
// Result types (mirror core/learn.ts — duplicated here to avoid pulling
// Node imports into the client bundle, per the organize-form.tsx pattern).
// ---------------------------------------------------------------------------

type LearnGenerator = "ollama" | "extractive";
type LearnStatus = "new" | "stale" | "fresh" | "skipped";

interface LearnClusterPlan {
  cluster: string;
  sources: string[];
  sourceHashes: string[];
  summaryPath: string;
  generator: LearnGenerator;
  status: LearnStatus;
  skipReason?: string;
}

interface LearnPlan {
  generatedAt: string;
  mode: "full" | "scoped";
  generator: LearnGenerator;
  ollamaError?: string;
  clusters: LearnClusterPlan[];
  stats: {
    total: number;
    new: number;
    stale: number;
    fresh: number;
    skipped: number;
  };
}

interface LearnWriteResult {
  cluster: string;
  summaryPath: string;
  generator: LearnGenerator;
  bytesWritten: number;
  overwrote: boolean;
}

interface ApplyLearnResult {
  applied: LearnWriteResult[];
  skipped: { cluster: string; reason: string }[];
  ledgerPath: string;
  ollamaError?: string;
}

interface UndoLearnResult {
  restored: number;
  conflicts: { path: string; reason: string }[];
  ledgerPath: string;
}

type LoadingState = "idle" | "plan" | "apply" | "undo";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * F2 error-parser — DO NOT SIMPLIFY.
 *
 * Parses a failing Response. Extracts `.error` from JSON if present, falls
 * back to raw body text. This matches the pattern in organize-form.tsx so
 * core-layer error messages surface cleanly.
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LearnForm() {
  const router = useRouter();

  const [plan, setPlan] = useState<LearnPlan | null>(null);
  const [lastApply, setLastApply] = useState<ApplyLearnResult | null>(null);
  const [lastUndo, setLastUndo] = useState<UndoLearnResult | null>(null);
  const [loading, setLoading] = useState<LoadingState>("idle");

  const [applyOpen, setApplyOpen] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);

  // Generator options (defaults match the CLI and organize-form).
  // useLlm=false disables Ollama and forces extractive.
  // useOllama=true means try Ollama first.
  const [useLlm, setUseLlm] = useState(true);
  const [useOllama, setUseOllama] = useState(true);
  const [ollamaModel, setOllamaModel] = useState("llama3.2");
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");
  const [force, setForce] = useState(false);

  const busy = loading !== "idle";

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const hasConflicts =
    plan !== null &&
    plan.clusters.some((c) => c.skipReason?.includes("user edited"));

  const canApply =
    plan !== null &&
    plan.clusters.some((c) => c.status === "new" || c.status === "stale") &&
    !busy;

  // -------------------------------------------------------------------------
  // Fetch handlers
  // -------------------------------------------------------------------------

  async function handlePlan() {
    setLoading("plan");
    try {
      const res = await fetch("/api/learn/plan", {
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
      const newPlan = (await res.json()) as LearnPlan;
      setPlan(newPlan);
      setLastApply(null);
      setLastUndo(null);
      const actionable = newPlan.clusters.filter(
        (c) => c.status === "new" || c.status === "stale",
      ).length;
      if (actionable === 0) {
        toast("All summaries are up-to-date — nothing to generate.");
      } else {
        toast.success(
          `Plan ready: ${actionable} cluster${actionable === 1 ? "" : "s"} to generate/refresh.`,
        );
      }
      if (newPlan.ollamaError) {
        toast.info(`Ollama unavailable — falling back to extractive tier.`);
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
      const res = await fetch("/api/learn/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan,
          force,
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
      const result = (await res.json()) as ApplyLearnResult;
      setLastApply(result);
      setLastUndo(null);
      // Plan is stale after apply — force a fresh plan before re-applying.
      setPlan(null);
      toast.success(
        `Wrote ${result.applied.length} summar${result.applied.length === 1 ? "y" : "ies"}${
          result.skipped.length > 0
            ? ` (${result.skipped.length} skipped)`
            : ""
        }.`,
      );
      // Refresh server components so the sidebar reflects any new _summary.md files.
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
      const res = await fetch("/api/learn/undo", { method: "POST" });
      if (!res.ok) {
        toast.error(await parseError(res));
        return;
      }
      const result = (await res.json()) as UndoLearnResult;
      setLastUndo(result);
      setLastApply(null);
      setPlan(null);
      toast.success(
        `Reverted ${result.restored} summar${result.restored === 1 ? "y" : "ies"}${
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
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Generator options */}
      <details className="rounded-md border p-3 text-sm [&[open]>summary]:mb-3">
        <summary className="cursor-pointer select-none text-sm font-medium">
          Generator options
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {useLlm
              ? useOllama
                ? `Ollama (${ollamaModel || "llama3.2"}) → extractive`
                : "extractive only"
              : "extractive only"}
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
              <div className="font-medium">Use LLM for summaries</div>
              <div className="text-xs text-muted-foreground">
                Uncheck to skip Ollama and use extractive summaries only (fast,
                offline, deterministic).
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
                summaries. Falls back to extractive if Ollama is unreachable.
              </div>
            </div>
          </label>
          <div className="grid gap-3 sm:grid-cols-2 pl-6">
            <div className="space-y-1">
              <label htmlFor="learn-ollama-model" className="text-xs font-medium">
                Ollama model
              </label>
              <Input
                id="learn-ollama-model"
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
              <label htmlFor="learn-ollama-url" className="text-xs font-medium">
                Ollama URL
              </label>
              <Input
                id="learn-ollama-url"
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
          <label className="flex items-start gap-2">
            <Checkbox
              checked={force}
              onCheckedChange={(v) => setForce(v === true)}
              disabled={busy}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div className="font-medium">Force regeneration</div>
              <div className="text-xs text-muted-foreground">
                Regenerate even if source files are unchanged (overrides
                idempotency). Also overwrites summaries you edited manually.
              </div>
            </div>
          </label>
        </div>
      </details>

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={handlePlan} disabled={busy}>
          {loading === "plan" ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Eye className="mr-2 h-4 w-4" />
          )}
          {loading === "plan" ? "Planning…" : "Plan"}
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
            <BookOpen className="mr-2 h-4 w-4" />
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
          {loading === "undo" ? "Undoing…" : "Undo last learn"}
        </Button>
      </div>

      {/* Apply-result banner */}
      {lastApply !== null && (
        <div className="rounded-md border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/50 p-4 text-sm">
          <div className="font-medium">
            Wrote {lastApply.applied.length} summar
            {lastApply.applied.length === 1 ? "y" : "ies"}.
          </div>
          {lastApply.skipped.length > 0 && (
            <div className="mt-2 text-muted-foreground">
              Skipped {lastApply.skipped.length}:{" "}
              {lastApply.skipped.map((s) => s.reason).join("; ")}
            </div>
          )}
          {lastApply.ollamaError && (
            <div className="mt-2 text-muted-foreground">
              Ollama unavailable — used extractive fallback.
            </div>
          )}
          <div className="mt-2 text-xs text-muted-foreground">
            Ledger: <code className="font-mono">{lastApply.ledgerPath}</code>.
            Use <em>Undo last learn</em> to reverse.
          </div>
        </div>
      )}

      {/* Undo-result banner */}
      {lastUndo !== null && (
        <div className="rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/50 p-4 text-sm">
          <div className="font-medium">
            Reverted {lastUndo.restored} summar
            {lastUndo.restored === 1 ? "y" : "ies"}.
          </div>
          {lastUndo.conflicts.length > 0 && (
            <div className="mt-2 text-muted-foreground">
              {lastUndo.conflicts.length} conflict
              {lastUndo.conflicts.length === 1 ? "" : "s"} (summaries edited
              after apply — left in place):
              <ul className="mt-1 ml-4 list-disc">
                {lastUndo.conflicts.map((c, i) => (
                  <li key={i}>
                    <code className="font-mono">{c.path}</code> — {c.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-2 text-xs text-muted-foreground">
            Ledger: <code className="font-mono">{lastUndo.ledgerPath}</code>.
          </div>
        </div>
      )}

      {/* Plan preview */}
      {plan !== null && (
        <LearnPreview plan={plan} hasConflicts={hasConflicts} />
      )}

      {/* Apply confirmation dialog */}
      <AlertDialog open={applyOpen} onOpenChange={setApplyOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply learn plan?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <div>
                  Will write{" "}
                  <strong>
                    {plan?.clusters.filter((c) => c.status === "new").length ??
                      0}{" "}
                    new
                  </strong>{" "}
                  and update{" "}
                  <strong>
                    {plan?.clusters.filter((c) => c.status === "stale").length ??
                      0}{" "}
                    stale
                  </strong>{" "}
                  summar
                  {(plan?.clusters.filter(
                    (c) => c.status === "new" || c.status === "stale",
                  ).length ?? 0) === 1
                    ? "y"
                    : "ies"}
                  , skip{" "}
                  <strong>
                    {plan?.clusters.filter((c) => c.status === "fresh").length ??
                      0}{" "}
                    unchanged
                  </strong>
                  .
                </div>
                {hasConflicts && (
                  <div className="rounded-md border border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/50 p-2 text-xs text-yellow-900 dark:text-yellow-200">
                    Some clusters have summaries you edited manually. Enable
                    &ldquo;Force regeneration&rdquo; in options to overwrite
                    them, or they will be skipped.
                  </div>
                )}
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

      {/* Undo confirmation dialog */}
      <AlertDialog open={undoOpen} onOpenChange={setUndoOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo last learn?</AlertDialogTitle>
            <AlertDialogDescription>
              Reverses the most recent applied learn. New summaries are moved to
              trash; overwritten summaries are restored byte-for-byte. Summaries
              you edited manually will be left in place and reported as
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
// LearnPreview sub-component
// ---------------------------------------------------------------------------

function LearnPreview({
  plan,
  hasConflicts,
}: {
  plan: LearnPlan;
  hasConflicts: boolean;
}) {
  const actionable = plan.clusters.filter(
    (c) => c.status === "new" || c.status === "stale",
  );

  if (plan.clusters.length === 0) {
    return (
      <div className="rounded-md border p-6 text-center text-muted-foreground">
        No eligible clusters found — folders need at least 3 notes to get a
        summary.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Summary badges */}
      <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
        <span>
          <strong className="text-foreground">{plan.stats.total}</strong>{" "}
          cluster{plan.stats.total === 1 ? "" : "s"} total
        </span>
        {plan.stats.new > 0 && (
          <>
            <Separator orientation="vertical" className="h-4" />
            <span>
              <Badge variant="secondary" className="mr-1">
                new
              </Badge>
              {plan.stats.new}
            </span>
          </>
        )}
        {plan.stats.stale > 0 && (
          <>
            <Separator orientation="vertical" className="h-4" />
            <span>
              <Badge variant="secondary" className="mr-1">
                stale
              </Badge>
              {plan.stats.stale}
            </span>
          </>
        )}
        {plan.stats.fresh > 0 && (
          <>
            <Separator orientation="vertical" className="h-4" />
            <span>
              <Badge variant="outline" className="mr-1">
                fresh
              </Badge>
              {plan.stats.fresh}
            </span>
          </>
        )}
        {plan.stats.skipped > 0 && (
          <>
            <Separator orientation="vertical" className="h-4" />
            <span>
              <Badge variant="outline" className="mr-1">
                skipped
              </Badge>
              {plan.stats.skipped}
            </span>
          </>
        )}
      </div>

      {/* Generator tier indicator */}
      <div className="text-xs text-muted-foreground">
        {plan.ollamaError ? (
          <span>
            Generator:{" "}
            <Badge variant="outline" className="mr-1 text-[10px]">
              extractive
            </Badge>
            (Ollama unavailable: {plan.ollamaError})
          </span>
        ) : plan.generator === "ollama" ? (
          <span>
            Generator:{" "}
            <Badge variant="secondary" className="mr-1 text-[10px]">
              Ollama
            </Badge>
            with extractive fallback per cluster
          </span>
        ) : (
          <span>
            Generator:{" "}
            <Badge variant="outline" className="mr-1 text-[10px]">
              extractive
            </Badge>
            (LLM disabled)
          </span>
        )}
      </div>

      {/* Conflict warning */}
      {hasConflicts && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/50 p-3 text-xs text-yellow-900 dark:text-yellow-200">
          Some clusters have summaries you edited after the last apply. They
          will be skipped unless you enable <strong>Force regeneration</strong>{" "}
          in options above.
        </div>
      )}

      {/* Per-cluster table */}
      {actionable.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">
            Clusters to generate ({actionable.length})
          </h2>
          <ClusterTable clusters={actionable} />
        </section>
      )}

      {/* Fresh clusters (collapsed) */}
      {plan.stats.fresh > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2 text-muted-foreground">
            Up-to-date ({plan.stats.fresh})
          </h2>
          <ClusterTable
            clusters={plan.clusters.filter((c) => c.status === "fresh")}
          />
        </section>
      )}

      {/* Skipped clusters */}
      {plan.stats.skipped > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2 text-muted-foreground">
            Skipped ({plan.stats.skipped})
          </h2>
          <ClusterTable
            clusters={plan.clusters.filter((c) => c.status === "skipped")}
          />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ClusterTable — renders a table of clusters
// ---------------------------------------------------------------------------

function ClusterTable({ clusters }: { clusters: LearnClusterPlan[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Cluster</TableHead>
          <TableHead className="w-16 text-right">Notes</TableHead>
          <TableHead className="w-24">Status</TableHead>
          <TableHead className="w-28">Generator</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {clusters.map((c) => (
          <TableRow key={c.cluster}>
            <TableCell>
              <code className="font-mono text-xs rounded bg-muted px-1.5 py-0.5">
                {c.cluster}/
              </code>
              {c.skipReason && (
                <span className="ml-2 text-xs text-muted-foreground">
                  ({c.skipReason})
                </span>
              )}
            </TableCell>
            <TableCell className="text-right text-muted-foreground">
              {c.sources.length}
            </TableCell>
            <TableCell>
              <StatusBadge status={c.status} />
            </TableCell>
            <TableCell>
              <Badge variant="outline" className="text-[10px]">
                {c.generator}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// StatusBadge — coloured badge per status
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: LearnStatus }) {
  switch (status) {
    case "new":
      return (
        <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 border-0 text-[10px]">
          new
        </Badge>
      );
    case "stale":
      return (
        <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 border-0 text-[10px]">
          stale
        </Badge>
      );
    case "fresh":
      return (
        <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 border-0 text-[10px]">
          fresh
        </Badge>
      );
    case "skipped":
      return (
        <Badge variant="outline" className="text-[10px]">
          skipped
        </Badge>
      );
  }
}
