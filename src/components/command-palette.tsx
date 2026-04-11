"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import type { SearchHit } from "@/core/types";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

export function CommandPalette() {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);

  // Register global Cmd+K / Ctrl+K listener
  // e.preventDefault() prevents browser "open location" on Firefox
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Debounced search: 150ms after query changes
  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`)
        .then((r) => r.json())
        .then((data: SearchHit[]) => setHits(data))
        .catch(() => setHits([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  const navigateTo = useCallback(
    (path: string) => {
      setOpen(false);
      setQuery("");
      setHits([]);
      router.push(path);
    },
    [router]
  );

  // Cycle theme: light → dark → system
  const cycleTheme = useCallback(() => {
    const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
    setTheme(next);
    setOpen(false);
  }, [theme, setTheme]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search notes or run a command…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {hits.length > 0 && (
          <CommandGroup heading="Notes">
            {hits.map((hit) => (
              <CommandItem
                key={hit.path}
                value={hit.path}
                onSelect={() =>
                  navigateTo(`/notes/${hit.path.replace(/\.md$/, "")}`)
                }
              >
                <span className="font-medium">{hit.title}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {hit.path}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />

        <CommandGroup heading="Actions">
          <CommandItem
            value="new-note"
            onSelect={() => navigateTo("/notes/new")}
          >
            New note
          </CommandItem>
          <CommandItem value="toggle-theme" onSelect={cycleTheme}>
            Toggle theme
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
