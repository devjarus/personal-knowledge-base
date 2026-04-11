"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { Note } from "@/core/types";

export function NoteEditor({ initial }: { initial: Note }) {
  const router = useRouter();
  const [body, setBody] = useState(initial.body);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(initial.path)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, frontmatter: initial.frontmatter }),
      });
      if (!res.ok) {
        // Parse JSON error body if available; fallback to raw text (F2 pattern)
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
      toast.success("Note saved");
      setEditing(false);
      router.refresh();
    } catch (e) {
      toast.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(initial.path)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("Note deleted");
        router.push("/");
        router.refresh();
      } else {
        // Parse JSON error body if available; fallback to raw text (F2 pattern)
        const text = await res.text();
        let msg = text || `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed?.error) msg = parsed.error;
        } catch {
          // Response wasn't JSON; fall back to raw text
        }
        toast.error(`Delete failed: ${msg}`);
      }
    } catch (e) {
      toast.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center flex-wrap">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? "Preview" : "Edit"}
        </Button>
        {editing && (
          <Button type="button" size="sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this note?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete{" "}
                <span className="font-mono text-foreground">{initial.path}</span>
                . This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={remove}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {editing ? (
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={20}
          className="font-mono text-sm resize-y"
          spellCheck={false}
        />
      ) : (
        <article className="prose prose-slate dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
        </article>
      )}
    </div>
  );
}
