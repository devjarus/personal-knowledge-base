import { notFound } from "next/navigation";
import { readNote } from "@/core/fs";
import { deriveTitle } from "@/core/frontmatter";
import { NoteEditor } from "@/components/note-editor";

export const dynamic = "force-dynamic";

export default async function NotePage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const relPath = slug.join("/");

  let note;
  try {
    note = await readNote(relPath);
  } catch {
    notFound();
  }

  const title = deriveTitle(note.frontmatter, note.body, note.slug);
  const fmEntries = Object.entries(note.frontmatter);

  return (
    <div className="grid grid-cols-[1fr_220px] gap-8 max-w-5xl">
      <div className="min-w-0 space-y-4">
        <header>
          <h1 className="text-2xl font-bold">{title}</h1>
          <div className="text-xs text-muted-foreground mt-1">{note.path}</div>
        </header>
        <NoteEditor initial={note} />
      </div>
      <aside className="text-xs space-y-3 border-l pl-4">
        <div className="font-semibold text-muted-foreground uppercase tracking-wide">
          metadata
        </div>
        {fmEntries.length === 0 && (
          <div className="text-muted-foreground">(no frontmatter)</div>
        )}
        <dl className="space-y-1">
          {fmEntries.map(([k, v]) => (
            <div key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-mono break-words">
                {Array.isArray(v) ? v.join(", ") : String(v)}
              </dd>
            </div>
          ))}
        </dl>
        <div className="pt-2 border-t">
          <div className="text-muted-foreground">size</div>
          <div className="font-mono">{note.size} bytes</div>
        </div>
        <div>
          <div className="text-muted-foreground">mtime</div>
          <div className="font-mono">{new Date(note.mtime).toLocaleString()}</div>
        </div>
      </aside>
    </div>
  );
}
