import Link from "next/link";
import { listNotes } from "@/core/fs";
import { buildLinkIndex } from "@/core/links";

export const dynamic = "force-dynamic";

/**
 * /stats — KB health dashboard.
 *
 * Read-only. Surfaces:
 *  - Note / link / cluster counts
 *  - Orphans (notes no other note links to) — for triage, no modification
 *  - Broken links (grouped by source note) — for triage, no modification
 *
 * Auto-generated cluster summaries (`type: cluster-summary`) are excluded
 * from the orphan list: they're system-generated, nobody would manually
 * link to them, and flagging them as orphans is noise.
 */
export default async function StatsPage() {
  const [notes, linkIndex] = await Promise.all([listNotes(), buildLinkIndex()]);

  // Orphans: no inbound links AND not a system-generated summary.
  const orphans = notes.filter(
    (n) =>
      n.type !== "cluster-summary" &&
      (linkIndex.inbound.get(n.path)?.length ?? 0) === 0,
  );

  // Group broken links by source note so readers can visit + fix in one hop.
  const brokenBySource = new Map<string, typeof linkIndex.broken>();
  for (const ref of linkIndex.broken) {
    const list = brokenBySource.get(ref.from) ?? [];
    list.push(ref);
    brokenBySource.set(ref.from, list);
  }
  const brokenSources = Array.from(brokenBySource.entries()).sort(
    (a, b) => b[1].length - a[1].length,
  );

  const totalOutbound = Array.from(linkIndex.outbound.values()).reduce(
    (sum, refs) => sum + refs.length,
    0,
  );
  const summaryCount = notes.filter((n) => n.type === "cluster-summary").length;

  return (
    <div className="space-y-8 max-w-4xl">
      <header>
        <h1 className="text-2xl font-bold">KB health</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Read-only overview of link rot, orphans, and cluster coverage.
        </p>
      </header>

      {/* Counts */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Notes" value={notes.length} />
        <Stat label="Links" value={totalOutbound} />
        <Stat
          label="Broken"
          value={linkIndex.broken.length}
          tone={linkIndex.broken.length > 0 ? "warn" : "ok"}
        />
        <Stat
          label="Orphans"
          value={orphans.length}
          tone={orphans.length > notes.length / 3 ? "warn" : "ok"}
        />
        <Stat label="Summaries" value={summaryCount} />
      </section>

      {/* Broken links */}
      <section>
        <h2 className="text-lg font-semibold mb-3">
          Broken links ({linkIndex.broken.length})
        </h2>
        {linkIndex.broken.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No broken links — every `[text](path)` and `[[wiki]]` resolves.
          </div>
        ) : (
          <ul className="space-y-2">
            {brokenSources.map(([source, refs]) => (
              <li
                key={source}
                className="rounded-lg border bg-card p-3 hover:bg-accent/50 transition-colors"
              >
                <Link
                  href={`/notes/${source.replace(/\.md$/, "")}`}
                  className="font-mono text-sm font-semibold hover:underline"
                >
                  {source}
                </Link>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {refs.length} broken link{refs.length === 1 ? "" : "s"}
                </div>
                <ul className="mt-2 space-y-1 text-xs font-mono text-muted-foreground">
                  {refs.slice(0, 5).map((ref, i) => (
                    <li key={i} className="truncate">
                      {ref.raw}
                    </li>
                  ))}
                  {refs.length > 5 && (
                    <li className="italic">+{refs.length - 5} more</li>
                  )}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Orphans */}
      <section>
        <h2 className="text-lg font-semibold mb-3">
          Orphans ({orphans.length})
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          Notes that no other note links to. Not a bug — imports and stubs
          often start as orphans. Link them from a summary or parent note to
          make them discoverable.
        </p>
        {orphans.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No orphans — every note has at least one inbound link.
          </div>
        ) : (
          <ul className="space-y-1 text-sm">
            {orphans.slice(0, 100).map((n) => (
              <li key={n.path}>
                <Link
                  href={`/notes/${n.path.replace(/\.md$/, "")}`}
                  className="hover:underline"
                >
                  <span className="text-foreground">{n.title}</span>
                  <span className="text-xs text-muted-foreground font-mono ml-2">
                    {n.path}
                  </span>
                </Link>
              </li>
            ))}
            {orphans.length > 100 && (
              <li className="text-xs text-muted-foreground italic pt-2">
                Showing first 100 of {orphans.length} — use{" "}
                <code className="font-mono">pnpm kb orphans --json</code> for
                the full list.
              </li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn" | "neutral";
}) {
  const toneClass =
    tone === "warn"
      ? "text-amber-600 dark:text-amber-400"
      : tone === "ok"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-foreground";
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${toneClass}`}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}
