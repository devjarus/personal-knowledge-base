"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Note } from "@/core/types";

export function NoteEditor({ initial }: { initial: Note }) {
  const router = useRouter();
  const [body, setBody] = useState(initial.body);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(initial.path)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, frontmatter: initial.frontmatter }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      setStatus("saved");
      setEditing(false);
      router.refresh();
    } catch (e) {
      setStatus(`error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete ${initial.path}?`)) return;
    const res = await fetch(`/api/notes/${encodeURIComponent(initial.path)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      router.push("/");
      router.refresh();
    } else {
      setStatus(`delete failed: ${await res.text()}`);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          className="px-3 py-1 text-sm rounded border"
          style={{ borderColor: "var(--kb-border)" }}
        >
          {editing ? "preview" : "edit"}
        </button>
        {editing && (
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-3 py-1 text-sm rounded border"
            style={{ borderColor: "var(--kb-border)" }}
          >
            {saving ? "saving…" : "save"}
          </button>
        )}
        <button
          type="button"
          onClick={remove}
          className="px-3 py-1 text-sm rounded border text-red-600"
          style={{ borderColor: "var(--kb-border)" }}
        >
          delete
        </button>
        {status && <span className="text-xs opacity-70">{status}</span>}
      </div>

      {editing ? (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="w-full h-[60vh] p-3 text-sm font-mono rounded border bg-transparent"
          style={{ borderColor: "var(--kb-border)" }}
          spellCheck={false}
        />
      ) : (
        <article className="kb-prose">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
        </article>
      )}
    </div>
  );
}
