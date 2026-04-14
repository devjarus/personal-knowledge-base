"use client";

import Link from "next/link";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SyncButton } from "@/components/sync-button";
import { ModeToggle } from "@/components/mode-toggle";
import { KbRootBadge } from "@/components/kb-root-badge";

interface TopBarProps {
  breadcrumb?: React.ReactNode;
}

export function TopBar({ breadcrumb }: TopBarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/80 backdrop-blur px-4">
      <SidebarTrigger aria-label="Toggle sidebar" />
      <Separator orientation="vertical" className="h-4" />
      {breadcrumb && <div className="flex items-center gap-2">{breadcrumb}</div>}
      <KbRootBadge />
      <div className="flex-1" />
      <Button asChild size="sm" variant="default">
        <Link href="/notes/new">New note</Link>
      </Button>
      <SyncButton />
      <ModeToggle />
    </header>
  );
}
