"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { SearchHit } from "@/core/types";

export function SearchBox() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((data: SearchHit[]) => {
          if (!cancelled) setHits(data);
        })
        .finally(() => !cancelled && setLoading(false));
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <div className="relative">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search…"
        className="w-full px-2 py-1 text-sm rounded border bg-transparent"
        style={{ borderColor: "var(--kb-border)" }}
      />
      {q && (
        <div
          className="absolute left-0 right-0 mt-1 z-10 max-h-72 overflow-y-auto rounded border shadow-lg"
          style={{ borderColor: "var(--kb-border)", background: "var(--kb-bg)" }}
        >
          {loading && <div className="text-xs px-2 py-1 opacity-60">searching…</div>}
          {!loading && hits.length === 0 && (
            <div className="text-xs px-2 py-1 opacity-60">no results</div>
          )}
          {hits.map((h) => (
            <Link
              key={h.path}
              href={`/notes/${h.path.replace(/\.md$/, "")}`}
              className="block px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/5 border-b last:border-b-0"
              style={{ borderColor: "var(--kb-border)" }}
              onClick={() => setQ("")}
            >
              <div className="font-semibold">{h.title}</div>
              <div className="opacity-60 truncate">{h.snippet}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
