"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deletedLocally: string[];
  deletedRemote: string[];
  skipped: number;
}

export function SyncButton() {
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "both", dryRun }),
      });
      const text = await res.text();
      if (!res.ok) {
        // Parse JSON error body; extract .error field; fallback to raw text
        // This is the F2 load-bearing error-parsing pattern (must not be simplified)
        let msg = text || `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed?.error) msg = parsed.error;
        } catch {
          // response wasn't JSON; fall back to raw text
        }
        toast.error(msg);
        return;
      }
      const data = JSON.parse(text) as SyncResult;
      const summary = `${dryRun ? "[dry-run] " : ""}↑${data.uploaded.length} ↓${data.downloaded.length} skipped:${data.skipped}`;
      toast.success(summary);
    } catch (e) {
      toast.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => run(true)}
        disabled={busy}
      >
        <RefreshCw className={cn("h-3.5 w-3.5 mr-1", busy && "animate-spin")} />
        Dry-run
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => run(false)}
        disabled={busy}
      >
        <RefreshCw className={cn("h-3.5 w-3.5 mr-1", busy && "animate-spin")} />
        Sync
      </Button>
    </div>
  );
}
