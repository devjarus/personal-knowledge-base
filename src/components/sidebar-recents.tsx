"use client";

/**
 * Recent-notes list for the sidebar. Replaces the old TreeNav.
 *
 * The full tree is nonfunctional past depth 3 (label width collapses), so
 * deep navigation moved to /browse (Miller columns). The sidebar now shows
 * the 15 most-recently-touched notes for fast return-to-work, plus the
 * top-level folders as entry points into /browse/<folder>.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, Folder } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type { NoteSummary, TreeNode } from "@/core/types";

const RECENT_LIMIT = 15;

export function SidebarRecents() {
  const pathname = usePathname();
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [topFolders, setTopFolders] = useState<TreeNode[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/notes").then((r) => r.json() as Promise<NoteSummary[]>),
      fetch("/api/tree").then((r) => r.json() as Promise<TreeNode>),
    ])
      .then(([notesData, treeData]) => {
        if (cancelled) return;
        setNotes(notesData);
        // listNotes returns mtime-desc already; take top N.
        const folders = (treeData.children ?? []).filter(
          (c) => c.type === "directory",
        );
        setTopFolders(folders);
      })
      .catch(() => {
        if (!cancelled) {
          setNotes([]);
          setTopFolders([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Folders</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {topFolders === null ? (
              <SidebarMenuItem>
                <div className="px-3 py-1.5 text-xs text-muted-foreground">
                  Loading…
                </div>
              </SidebarMenuItem>
            ) : topFolders.length === 0 ? (
              <SidebarMenuItem>
                <div className="px-3 py-1.5 text-xs text-muted-foreground">
                  (no folders)
                </div>
              </SidebarMenuItem>
            ) : (
              topFolders.map((folder) => {
                const href = `/browse/${folder.path}`;
                const isActive = pathname.startsWith(href);
                return (
                  <SidebarMenuItem key={folder.path}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={folder.name}>
                      <Link href={href} className="gap-2">
                        <Folder
                          className={cn(
                            "h-4 w-4 shrink-0",
                            isActive
                              ? "text-sidebar-accent-foreground"
                              : "text-muted-foreground",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {folder.name}
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel>Recent</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {notes === null ? (
              <SidebarMenuItem>
                <div className="px-3 py-1.5 text-xs text-muted-foreground">
                  Loading…
                </div>
              </SidebarMenuItem>
            ) : notes.length === 0 ? (
              <SidebarMenuItem>
                <div className="px-3 py-1.5 text-xs text-muted-foreground">
                  (no notes yet)
                </div>
              </SidebarMenuItem>
            ) : (
              notes.slice(0, RECENT_LIMIT).map((note) => {
                const slug = note.path.replace(/\.md$/, "");
                const href = `/notes/${slug}`;
                const isActive = pathname === href;
                return (
                  <SidebarMenuItem key={note.path}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={note.title}
                    >
                      <Link href={href} className="gap-2">
                        <FileText
                          className={cn(
                            "h-4 w-4 shrink-0",
                            isActive
                              ? "text-sidebar-accent-foreground"
                              : "text-muted-foreground",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {note.title}
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}
