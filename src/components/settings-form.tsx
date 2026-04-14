"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SettingsFormProps {
  initialPath: string;
  isEnvActive: boolean;
}

export function SettingsForm({ initialPath, isEnvActive }: SettingsFormProps) {
  const router = useRouter();
  const [newPath, setNewPath] = useState(initialPath);
  const [saving, setSaving] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kbRoot: newPath }),
      });
      const text = await res.text();
      if (!res.ok) {
        // F2 error-parsing pattern — must not be simplified
        let msg = text || `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed?.error) msg = parsed.error;
        } catch {
          // response wasn't JSON; fall back to raw text
        }
        toast.error(msg);
        return;
      }
      // Success
      let envOverrideHint: string | undefined;
      try {
        const parsed = JSON.parse(text) as { envOverrideHint?: string };
        envOverrideHint = parsed.envOverrideHint;
      } catch {
        // Not JSON — ignore
      }
      toast.success("KB root saved successfully.");
      if (envOverrideHint || isEnvActive) {
        toast.warning(
          envOverrideHint ??
            "KB_ROOT environment variable is set and overrides this saved value.",
        );
      }
      // Refresh server component data to reflect the new config
      router.refresh();
    } catch (e) {
      toast.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <label
          htmlFor="kb-root-path"
          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        >
          New KB root path
        </label>
        <Input
          id="kb-root-path"
          type="text"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          placeholder="/absolute/path/to/your/kb"
          className="font-mono text-sm"
          disabled={saving}
        />
        <p className="text-xs text-muted-foreground">
          Must be an absolute path to an existing, readable, and writable
          directory. Symlinks will be resolved to their canonical target.
          {isEnvActive && (
            <span className="block mt-1 text-yellow-600 dark:text-yellow-400">
              The KB_ROOT environment variable is active and will override this
              value until it is removed from your environment.
            </span>
          )}
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
