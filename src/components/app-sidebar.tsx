"use client";

import Link from "next/link";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";
import { TreeNav } from "@/components/tree-nav";
import { SearchBox } from "@/components/search-box";

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border px-4 py-3">
        <Link href="/" className="font-bold text-lg text-sidebar-foreground">
          kb
        </Link>
        <div className="mt-2">
          <SearchBox />
        </div>
      </SidebarHeader>
      <SidebarContent className="overflow-y-auto">
        <TreeNav />
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border px-4 py-2">
        <div className="text-xs text-muted-foreground">
          local · markdown · S3 sync
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
