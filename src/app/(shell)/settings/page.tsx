/**
 * /settings — Server component shell.
 * Reads config via core layer (no HTTP round-trip for initial render).
 * Client child <SettingsForm> owns the interactive save/validate flow.
 */

import path from "node:path";
import { resolveKbRoot } from "@/core/paths";
import { configFilePath, readConfigSync } from "@/core/config";
import { listNotes } from "@/core/fs";
import { Badge } from "@/components/ui/badge";
import { SettingsForm } from "@/components/settings-form";

const SOURCE_LABELS: Record<string, string> = {
  env: "Environment variable (KB_ROOT)",
  config: "Config file",
  walkup: "Walk-up from cwd",
  fallback: "Default fallback",
};

export default async function SettingsPage() {
  const { path: kbRootPath, source } = resolveKbRoot();
  const cfp = configFilePath();
  const configData = readConfigSync();
  const savedKbRoot = configData?.kbRoot ?? null;
  const envKbRoot = process.env.KB_ROOT
    ? path.resolve(process.env.KB_ROOT)
    : null;

  let noteCount = 0;
  try {
    const notes = await listNotes();
    noteCount = notes.length;
  } catch {
    // KB root may not exist yet — show 0
  }

  const isEnvActive = !!envKbRoot;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure where your knowledge base lives on disk.
        </p>
      </div>

      {/* Env-override warning banner */}
      {isEnvActive && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-50 dark:bg-yellow-950/20 px-4 py-3 text-sm text-yellow-800 dark:text-yellow-300">
          <strong>Note:</strong> The <code className="mx-1 font-mono">KB_ROOT</code>
          environment variable is set to{" "}
          <code className="font-mono break-all">{envKbRoot}</code>.
          The environment variable always takes priority over the config file.
          Any path you save here will be stored but will not take effect until
          you remove the <code className="mx-1 font-mono">KB_ROOT</code>{" "}
          environment variable.
        </div>
      )}

      {/* Current config info */}
      <div className="rounded-lg border bg-card p-5 space-y-3">
        <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
          Current configuration
        </h2>
        <dl className="space-y-2 text-sm">
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">Effective KB root</dt>
            <dd className="font-mono break-all font-medium">{kbRootPath}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">Source layer</dt>
            <dd>
              <Badge variant={source === "env" ? "destructive" : "secondary"}>
                {SOURCE_LABELS[source] ?? source}
              </Badge>
            </dd>
          </div>
          {envKbRoot && (
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground">
                <code className="font-mono">KB_ROOT</code> env value
              </dt>
              <dd className="font-mono break-all">{envKbRoot}</dd>
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">Config file path</dt>
            <dd className="font-mono break-all">{cfp}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">Config file</dt>
            <dd>
              {configData ? (
                <span className="text-green-600 dark:text-green-400">exists</span>
              ) : (
                <span className="text-muted-foreground">missing (not yet configured)</span>
              )}
            </dd>
          </div>
          {savedKbRoot && (
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground">Saved KB root (config file)</dt>
              <dd className="font-mono break-all">{savedKbRoot}</dd>
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">Note count</dt>
            <dd>{noteCount} notes</dd>
          </div>
        </dl>
      </div>

      {/* Edit form */}
      <div className="rounded-lg border bg-card p-5 space-y-4">
        <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
          Change KB root
        </h2>
        <SettingsForm
          initialPath={savedKbRoot ?? kbRootPath}
          isEnvActive={isEnvActive}
        />
      </div>
    </div>
  );
}
