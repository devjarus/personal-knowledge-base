import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { TreeNav } from "./components/tree-nav";
import { SearchBox } from "./components/search-box";

export const metadata: Metadata = {
  title: "Personal KB",
  description: "Local-first markdown knowledge base",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen flex">
          <aside
            className="w-72 shrink-0 border-r p-4 flex flex-col gap-4"
            style={{ borderColor: "var(--kb-border)", background: "var(--kb-surface)" }}
          >
            <div className="flex items-center justify-between">
              <Link href="/" className="font-bold text-lg">
                kb
              </Link>
              <Link
                href="/notes/new"
                className="text-xs px-2 py-1 rounded border"
                style={{ borderColor: "var(--kb-border)" }}
              >
                + new
              </Link>
            </div>
            <SearchBox />
            <div className="overflow-y-auto flex-1 -mx-1">
              <TreeNav />
            </div>
            <div
              className="text-xs pt-2 border-t"
              style={{ color: "var(--kb-muted)", borderColor: "var(--kb-border)" }}
            >
              local · markdown · S3 sync
            </div>
          </aside>
          <main className="flex-1 p-8 overflow-y-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}
