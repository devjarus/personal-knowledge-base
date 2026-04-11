import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { TopBar } from "@/components/top-bar";
import { CommandPaletteLoader } from "@/components/command-palette-loader";

export default function ShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider defaultOpen={true}>
      <AppSidebar />
      <SidebarInset>
        <TopBar />
        <main className="flex-1 p-6 overflow-y-auto">{children}</main>
      </SidebarInset>
      {/* CommandPaletteLoader is a client component that dynamically imports the palette with SSR disabled */}
      <CommandPaletteLoader />
    </SidebarProvider>
  );
}
