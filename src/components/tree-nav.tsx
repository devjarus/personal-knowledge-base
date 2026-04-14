"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Folder, FileText } from "lucide-react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type { TreeNode } from "@/core/types";

function DirItem({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const children = node.children ?? [];

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={node.name}
        className="gap-2"
        onClick={() => setOpen((o) => !o)}
      >
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span>{node.name}</span>
        <ChevronRight
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-90"
          )}
        />
      </SidebarMenuButton>
      {open && (
        <SidebarMenuSub>
          {children.map((child) => (
            // Use the full relative path as key (never just the basename) so
            // React can distinguish e.g. two folders both named "workspace"
            // under different parents. child.path is always set by buildTree.
            <TreeItem key={child.path} node={child} depth={depth + 1} />
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

function FileItem({ node }: { node: TreeNode }) {
  const pathname = usePathname();
  const slug = node.path.replace(/\.md$/, "");
  const href = `/notes/${slug}`;
  const isActive = pathname === href;

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={isActive}>
        <Link href={href} className="gap-2">
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span>{node.name.replace(/\.md$/, "")}</span>
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

function RootFileItem({ node }: { node: TreeNode }) {
  const pathname = usePathname();
  const slug = node.path.replace(/\.md$/, "");
  const href = `/notes/${slug}`;
  const isActive = pathname === href;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={node.name.replace(/\.md$/, "")}
      >
        <Link href={href} className="gap-2">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{node.name.replace(/\.md$/, "")}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  if (node.type === "file") {
    if (depth === 0) {
      return <RootFileItem node={node} />;
    }
    return <FileItem node={node} />;
  }
  return <DirItem node={node} depth={depth} />;
}

export function TreeNav() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tree")
      .then((r) => r.json())
      .then((data: TreeNode) => {
        if (!cancelled) setTree(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch when the pathname changes so the tree updates after an import
    // (combined with router.refresh() in import-form.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  if (error) {
    return (
      <div className="px-4 text-xs text-destructive">tree error: {error}</div>
    );
  }
  if (!tree) {
    return (
      <div className="px-4 text-xs text-muted-foreground">Loading…</div>
    );
  }

  const children = tree.children ?? [];

  return (
    <SidebarMenu>
      {children.map((child) => (
        // Use the full relative path as key — never the bare basename — so
        // React won't confuse two nodes that share the same directory name
        // at different levels (e.g. two "workspace" dirs in different parents).
        <TreeItem key={child.path} node={child} depth={0} />
      ))}
    </SidebarMenu>
  );
}
