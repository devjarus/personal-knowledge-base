"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderInput } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { TreeNav } from "@/components/tree-nav";
import { SearchBox } from "@/components/search-box";

export function AppSidebar() {
  const pathname = usePathname();

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
        {/* Quick actions — New note is in the top bar; Import lives here */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="Import notes"
                  isActive={pathname === "/import"}
                >
                  <Link href="/import" className="gap-2">
                    <FolderInput className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span>Import</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
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
