"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewNotePage() {
  const router = useRouter();
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!path.trim()) {
      setError("path is required");
      return;
    }
    setBusy(true);
    try {
      const fm: Record<string, unknown> = {};
      if (title.trim()) fm.title = title.trim();
      if (tags.trim())
        fm.tags = tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, body, frontmatter: fm }),
      });
      if (!res.ok) throw new Error(await res.text());
      const note = await res.json();
      router.push(`/notes/${note.path.replace(/\.md$/, "")}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">new note</h1>
      <div className="space-y-1">
        <label className="text-xs opacity-70">path (e.g. inbox/idea-2026.md)</label>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="folder/slug.md"
          className="w-full px-2 py-1 rounded border bg-transparent text-sm font-mono"
          style={{ borderColor: "var(--kb-border)" }}
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs opacity-70">title (optional)</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-2 py-1 rounded border bg-transparent text-sm"
          style={{ borderColor: "var(--kb-border)" }}
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs opacity-70">tags (comma-separated)</label>
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          className="w-full px-2 py-1 rounded border bg-transparent text-sm"
          style={{ borderColor: "var(--kb-border)" }}
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs opacity-70">body</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="w-full h-64 p-2 rounded border bg-transparent text-sm font-mono"
          style={{ borderColor: "var(--kb-border)" }}
        />
      </div>
      {error && <div className="text-sm text-red-500">{error}</div>}
      <button
        type="submit"
        disabled={busy}
        className="px-4 py-2 rounded border"
        style={{ borderColor: "var(--kb-border)" }}
      >
        {busy ? "creating…" : "create"}
      </button>
    </form>
  );
}
