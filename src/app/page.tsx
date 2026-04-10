import Link from "next/link";
import { listNotes } from "@/core/fs";
import { isSyncConfigured } from "@/core/sync";
import { SyncButton } from "./components/sync-button";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const notes = await listNotes();
  const recent = notes.slice(0, 20);
  const syncOn = isSyncConfigured();

  return (
    <div className="space-y-6 max-w-3xl">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">your knowledge base</h1>
        <Link
          href="/notes/new"
          className="px-3 py-1 text-sm rounded border"
          style={{ borderColor: "var(--kb-border)" }}
        >
          + new note
        </Link>
      </header>

      <section
        className="rounded border p-3 flex items-center justify-between"
        style={{ borderColor: "var(--kb-border)" }}
      >
        <div className="text-sm">
          <span className="font-semibold">sync:</span>{" "}
          {syncOn ? (
            <span style={{ color: "var(--kb-accent)" }}>configured</span>
          ) : (
            <span style={{ color: "var(--kb-muted)" }}>not configured (set KB_S3_BUCKET)</span>
          )}
        </div>
        <SyncButton />
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">recent ({notes.length} total)</h2>
        {recent.length === 0 && (
          <div className="text-sm opacity-60">
            no notes yet —{" "}
            <Link href="/notes/new" className="underline">
              create your first
            </Link>
          </div>
        )}
        <ul className="space-y-2">
          {recent.map((n) => (
            <li
              key={n.path}
              className="rounded border p-3"
              style={{ borderColor: "var(--kb-border)" }}
            >
              <Link
                href={`/notes/${n.path.replace(/\.md$/, "")}`}
                className="font-semibold"
              >
                {n.title}
              </Link>
              <div className="text-xs opacity-60 mt-0.5">
                {n.path} · {new Date(n.mtime).toLocaleString()}
                {n.tags.length > 0 && <> · {n.tags.map((t) => `#${t}`).join(" ")}</>}
              </div>
              {n.preview && (
                <div className="text-sm mt-1 opacity-80 line-clamp-2">{n.preview}</div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
