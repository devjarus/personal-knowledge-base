"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

/** Browser-safe basename: last segment of a Unix or Windows path. */
function basename(p: string): string {
  return p.replace(/[/\\]$/, "").split(/[/\\]/).pop() ?? p;
}

interface ConfigPayload {
  kbRoot: string;
  source: "env" | "config" | "walkup" | "fallback";
}

const MAX_LABEL_LEN = 20;

function truncate(s: string): string {
  return s.length > MAX_LABEL_LEN ? "…" + s.slice(-(MAX_LABEL_LEN - 1)) : s;
}

export function KbRootBadge() {
  const [config, setConfig] = useState<ConfigPayload | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/config", { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ConfigPayload>;
      })
      .then(setConfig)
      .catch((e: unknown) => {
        // AbortError is expected on unmount — don't log it
        if (e instanceof Error && e.name !== "AbortError") {
          console.error("[KbRootBadge] fetch error:", e);
        }
      });
    return () => controller.abort();
  }, []);

  if (!config) {
    // Neutral skeleton while loading
    return (
      <span
        className="inline-block h-5 w-20 animate-pulse rounded bg-muted"
        aria-label="Loading KB location"
      />
    );
  }

  const lastSegment = basename(config.kbRoot) || config.kbRoot;
  const label = `KB: ${truncate(lastSegment)}`;
  const titleText = `KB root: ${config.kbRoot} (source: ${config.source})`;

  return (
    <Link href="/settings" title={titleText}>
      <Badge variant="secondary" className="cursor-pointer hover:bg-secondary/80 font-mono text-xs">
        {label}
      </Badge>
    </Link>
  );
}
