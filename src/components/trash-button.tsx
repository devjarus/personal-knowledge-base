"use client";

/**
 * Sidebar footer: Trash summary + Empty button.
 *
 * Polls `GET /api/trash` on mount and after every pathname change (so the
 * count reflects recent deletes without a manual reload). Hidden entirely
 * when the trash is empty — no visual noise for first-time users.
 *
 * "Empty" permanently removes `<KB_ROOT>/.trash/` via `DELETE /api/trash`.
 * The server route is the only spot in the UI that calls `fs.rm` on any
 * user-adjacent content, and it is scoped to the trash directory only.
 */

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
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

interface TrashStats {
  batches: number;
  files: number;
}

export function TrashButton() {
  const pathname = usePathname();
  const router = useRouter();
  const [stats, setStats] = useState<TrashStats | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  async function refresh() {
    try {
      const res = await fetch("/api/trash", { cache: "no-store" });
      if (!res.ok) return;
      setStats(await res.json());
    } catch {
      // Silent — trash is a secondary surface, don't spam errors on every poll.
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/trash", { cache: "no-store" }).catch(
        () => null,
      );
      if (cancelled || !res || !res.ok) return;
      setStats((await res.json()) as TrashStats);
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (!stats || stats.files === 0) return null;

  const label = `${stats.files} file${stats.files === 1 ? "" : "s"} in ${stats.batches} batch${stats.batches === 1 ? "" : "es"}`;

  async function doEmpty() {
    try {
      const res = await fetch("/api/trash", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "empty trash failed");
        return;
      }
      toast.success(
        `Permanently deleted ${data.deleted} note${data.deleted === 1 ? "" : "s"}.`,
      );
      setStats({ batches: 0, files: 0 });
      startTransition(() => {
        router.refresh();
        void refresh();
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Trash2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto shrink-0 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setConfirmOpen(true)}
          disabled={pending}
        >
          Empty
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Permanently delete {stats.files} note{stats.files === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes <code>{"<KB_ROOT>/.trash/"}</code> from disk. Unlike
              the soft-delete from Browse, this cannot be undone without a
              backup or <code>git</code> history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                setConfirmOpen(false);
                await doEmpty();
              }}
            >
              Empty permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
