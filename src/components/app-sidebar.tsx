"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderInput, FolderTree, Settings } from "lucide-react";
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
import { SidebarRecents } from "@/components/sidebar-recents";
import { SearchBox } from "@/components/search-box";
import { TrashButton } from "@/components/trash-button";

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
                  tooltip="Browse (Miller columns)"
                  isActive={pathname.startsWith("/browse")}
                >
                  <Link href="/browse" className="gap-2">
                    <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span>Browse</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
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
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="Settings"
                  isActive={pathname === "/settings"}
                >
                  <Link href="/settings" className="gap-2">
                    <Settings className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span>Settings</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarRecents />
      </SidebarContent>
      <SidebarFooter className="flex flex-col gap-2 border-t border-sidebar-border px-3 py-2">
        <TrashButton />
        <div className="px-1 text-xs text-muted-foreground">
          local · markdown · S3 sync
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
