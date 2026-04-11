import Link from "next/link";
import { listNotes } from "@/core/fs";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const notes = await listNotes();
  const recent = notes.slice(0, 20);

  return (
    <div className="space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-bold">Your knowledge base</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {notes.length} {notes.length === 1 ? "note" : "notes"} total
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold mb-3">Recent notes</h2>
        {recent.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No notes yet —{" "}
            <Link href="/notes/new" className="underline text-primary">
              create your first
            </Link>
          </div>
        )}
        <ul className="space-y-2">
          {recent.map((n) => (
            <li
              key={n.path}
              className="rounded-lg border bg-card p-3 hover:bg-accent/50 transition-colors"
            >
              <Link
                href={`/notes/${n.path.replace(/\.md$/, "")}`}
                className="font-semibold text-card-foreground hover:underline"
              >
                {n.title}
              </Link>
              <div className="text-xs text-muted-foreground mt-0.5">
                {n.path} · {new Date(n.mtime).toLocaleString()}
                {n.tags.length > 0 && (
                  <> · {n.tags.map((t) => `#${t}`).join(" ")}</>
                )}
              </div>
              {n.preview && (
                <div className="text-sm mt-1 text-muted-foreground line-clamp-2">
                  {n.preview}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
