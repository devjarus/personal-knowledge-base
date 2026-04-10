"use client";

import { useState } from "react";

interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deletedLocally: string[];
  deletedRemote: string[];
  skipped: number;
}

export function SyncButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "both", dryRun }),
      });
      const text = await res.text();
      if (!res.ok) {
        setResult(text || `HTTP ${res.status}`);
        return;
      }
      const data = JSON.parse(text) as SyncResult;
      setResult(
        `${dryRun ? "[dry-run] " : ""}↑${data.uploaded.length} ↓${data.downloaded.length} skipped:${data.skipped}`,
      );
    } catch (e) {
      setResult(`error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => run(true)}
        disabled={busy}
        className="px-3 py-1 text-sm rounded border"
        style={{ borderColor: "var(--kb-border)" }}
      >
        sync (dry-run)
      </button>
      <button
        type="button"
        onClick={() => run(false)}
        disabled={busy}
        className="px-3 py-1 text-sm rounded border"
        style={{ borderColor: "var(--kb-border)" }}
      >
        sync
      </button>
      {result && <span className="text-xs opacity-70">{result}</span>}
    </div>
  );
}
