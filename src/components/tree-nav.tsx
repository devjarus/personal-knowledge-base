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
            <TreeItem key={child.path || child.name} node={child} depth={depth + 1} />
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
  }, []);

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
        <TreeItem key={child.path || child.name} node={child} depth={0} />
      ))}
    </SidebarMenu>
  );
}
