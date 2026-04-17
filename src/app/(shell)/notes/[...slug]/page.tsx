import { notFound } from "next/navigation";
import Link from "next/link";
import { readNote, listNotes } from "@/core/fs";
import { deriveTitle } from "@/core/frontmatter";
import { buildLinkIndex } from "@/core/links";
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

  // Build link index and look up inbound refs for this note.
  // listNotes() and buildLinkIndex() are both cached — cheap on repeated renders.
  const [allNotes, linkIndex] = await Promise.all([listNotes(), buildLinkIndex()]);

  // Build a map of path → title for source-note lookups (one pass, O(n)).
  const titleByPath = new Map<string, string>(
    allNotes.map((n) => [n.path, n.title]),
  );

  // Inbound refs pointing at the current note, deduped by source path
  // (a single source can link to this note multiple times — render one row
  // per unique source), then sorted by source title (case-insensitive).
  const inboundRefs = Array.from(
    new Map(
      (linkIndex.inbound.get(note.path) ?? []).map((ref) => [ref.from, ref]),
    ).values(),
  ).sort(
    (a, b) =>
      (titleByPath.get(a.from) ?? a.from)
        .toLowerCase()
        .localeCompare((titleByPath.get(b.from) ?? b.from).toLowerCase()),
  );

  // Count broken outbound links from this note (T3 — fits well under 20 lines).
  const brokenCount = linkIndex.broken.filter((r) => r.from === note.path).length;

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
          <div className="font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            backlinks
          </div>
          {inboundRefs.length === 0 ? (
            <div className="text-muted-foreground">(no backlinks)</div>
          ) : (
            <ul className="space-y-1">
              {inboundRefs.map((ref) => (
                <li key={ref.from}>
                  <Link
                    href={`/notes/${ref.from.replace(/\.md$/, "")}`}
                    className="text-foreground underline underline-offset-2 hover:text-primary break-words"
                  >
                    {titleByPath.get(ref.from) ?? ref.from}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {brokenCount > 0 && (
            <div
              className="mt-2 text-muted-foreground"
              aria-label={`${brokenCount} broken outbound link${brokenCount === 1 ? "" : "s"} from this note`}
            >
              {brokenCount} broken link{brokenCount === 1 ? "" : "s"}
            </div>
          )}
        </div>
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
