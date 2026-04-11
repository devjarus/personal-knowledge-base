"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function NewNotePage() {
  const router = useRouter();
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!path.trim()) {
      toast.error("Path is required");
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
      if (!res.ok) {
        const text = await res.text();
        let msg = text || `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed?.error) msg = parsed.error;
        } catch {
          // Response wasn't JSON; fall back to raw text
        }
        toast.error(msg);
        return;
      }
      const note = (await res.json()) as { path: string };
      router.push(`/notes/${note.path.replace(/\.md$/, "")}`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-5">
      <h1 className="text-2xl font-bold">New note</h1>

      <div className="space-y-1.5">
        <label className="text-sm text-muted-foreground" htmlFor="note-path">
          Path (e.g. inbox/idea-2026.md)
        </label>
        <Input
          id="note-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="folder/slug.md"
          className="font-mono text-sm"
          required
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm text-muted-foreground" htmlFor="note-title">
          Title (optional)
        </label>
        <Input
          id="note-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm text-muted-foreground" htmlFor="note-tags">
          Tags (comma-separated)
        </label>
        <Input
          id="note-tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="tag1, tag2"
          className="text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm text-muted-foreground" htmlFor="note-body">
          Body
        </label>
        <Textarea
          id="note-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          className="font-mono text-sm resize-y"
        />
      </div>

      <Button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create"}
      </Button>
    </form>
  );
}
