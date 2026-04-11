"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { SearchHit } from "@/core/types";

export function SearchBox() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((data: SearchHit[]) => {
          if (!cancelled) {
            setHits(data);
            setOpen(true);
          }
        })
        .finally(() => !cancelled && setLoading(false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setQ("");
      setOpen(false);
    }
  }

  function selectHit(hit: SearchHit) {
    setQ("");
    setOpen(false);
    router.push(`/notes/${hit.path.replace(/\.md$/, "")}`);
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search…"
          className="pl-7 h-8 text-sm"
          aria-label="Search notes"
        />
      </div>
      {open && q && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 max-h-72 overflow-y-auto rounded-md border bg-popover shadow-md">
          {loading && (
            <div className="text-xs px-3 py-2 text-muted-foreground">
              Searching…
            </div>
          )}
          {!loading && hits.length === 0 && (
            <div className="text-xs px-3 py-2 text-muted-foreground">
              No results
            </div>
          )}
          {hits.map((h) => (
            <button
              key={h.path}
              type="button"
              className="block w-full text-left px-3 py-2 text-xs hover:bg-accent hover:text-accent-foreground border-b last:border-b-0 cursor-pointer"
              onClick={() => selectHit(h)}
            >
              <div className="font-semibold">{h.title}</div>
              <div className="text-muted-foreground truncate">{h.snippet}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
