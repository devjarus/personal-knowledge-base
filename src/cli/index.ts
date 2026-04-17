#!/usr/bin/env tsx
/**
 * `kb` CLI — thin commander wrapper around the core library.
 */

// Load .env.local from the project root BEFORE any module that reads env vars
// (kbRoot() in ./paths reads process.env.KB_ROOT at call time). Next.js
// auto-loads .env.local; tsx does not — this closes the gap so `pnpm kb ...`
// and the UI use the same KB_ROOT without requiring manual `export`.
// Minimal inline parser: KEY=VALUE lines, # comments, optional surrounding
// quotes. Existing env vars win (override=false), so CLI caller can still
// override with `KB_ROOT=/other pnpm kb ...`.
import { fileURLToPath as _fileURLToPath } from "node:url";
import path_ from "node:path";
import { readFileSync as _readFileSync, existsSync as _existsSync } from "node:fs";
{
  const __cliDir = path_.dirname(_fileURLToPath(import.meta.url));
  const envPath = path_.join(__cliDir, "..", "..", ".env.local");
  if (_existsSync(envPath)) {
    for (const line of _readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue; // caller override wins
      let val = m[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

import { Command } from "commander";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";

import {
  listNotes,
  readNote,
  writeNote,
  deleteNote,
  buildTree,
} from "../core/fs";
import { searchNotes } from "../core/search";
import { sync } from "../core/sync";
import { importNotes } from "../core/import";
import { kbStats } from "../core/stats";
import { buildLinkIndex } from "../core/links";
import { rebuildIndex, refreshIndex } from "../core/semanticIndex";
import {
  buildOrganizePlan,
  applyOrganizePlan,
  undoLastOrganize,
  OrganizeError,
} from "../core/organize";
import type { OrganizePlan, OrganizeMove } from "../core/organize";
import {
  buildLearnPlan,
  applyLearnPlan,
  undoLastLearn,
  LearnError,
} from "../core/learn";
import type { LearnPlan, LearnClusterPlan } from "../core/learn";
import {
  buildLinkArchivePlan,
  applyLinkArchivePlan,
  undoLastLinkArchive,
} from "../core/linkArchive";
import type { LinkArchivePlan } from "../core/linkArchive";
import type { TreeNode } from "../core/types";

// Tiny ANSI helpers — no extra dependency.
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function color(str: string, code: string): string {
  if (!process.stdout.isTTY) return str;
  return `${code}${str}${c.reset}`;
}

function fail(msg: string): never {
  process.stderr.write(`${color("error:", c.red)} ${msg}\n`);
  process.exit(1);
}

const program = new Command();
program
  .name("kb")
  .description("Personal knowledge base CLI")
  .version("0.1.0");

program
  .command("ls")
  .description("List notes (optionally scoped to a folder prefix)")
  .argument("[prefix]", "folder prefix to filter by")
  .option("--json", "emit raw JSON array of NoteSummary objects")
  .action(async (prefix?: string, opts?: { json?: boolean }) => {
    const notes = await listNotes();
    const filtered = prefix
      ? notes.filter((n) => n.path.startsWith(prefix.replace(/\/$/, "") + "/"))
      : notes;

    if (opts?.json) {
      process.stdout.write(JSON.stringify(filtered, null, 2) + "\n");
      return;
    }

    if (filtered.length === 0) {
      process.stdout.write(color("(no notes)\n", c.dim));
      return;
    }
    for (const n of filtered) {
      const tags = n.tags.length ? color(` ${n.tags.map((t) => `#${t}`).join(" ")}`, c.cyan) : "";
      process.stdout.write(
        `${color(n.path, c.blue)}  ${color(n.title, c.bold)}${tags}\n`,
      );
    }
  });

program
  .command("cat")
  .description("Print a note's raw contents (optionally a line range)")
  .argument("<path>", "KB-relative path, optionally with :N suffix for a single line")
  .option("--lines <range>", "line range to print, e.g. 5-10 or 42 (1-indexed, inclusive)")
  .option(
    "--json",
    "emit JSON {path, frontmatter, body, raw, size, mtime} instead of raw text",
  )
  .action(async (notePath: string, opts: { lines?: string; json?: boolean }) => {
    // Resolve line anchoring.
    // Form 1: path.md:42 — split off numeric suffix after the last colon.
    let resolvedPath = notePath;
    let lineStart: number | undefined;
    let lineEnd: number | undefined;

    const colonIdx = notePath.lastIndexOf(":");
    if (colonIdx > 0) {
      const suffix = notePath.slice(colonIdx + 1);
      // Only trigger if the suffix is a positive integer (avoids breaking
      // paths with colons that don't end in a number).
      if (/^\d+$/.test(suffix) && Number(suffix) > 0) {
        resolvedPath = notePath.slice(0, colonIdx);
        lineStart = Number(suffix);
        lineEnd = lineStart;
      }
    }

    // Form 2: --lines a-b or --lines a
    if (opts.lines !== undefined && lineStart === undefined) {
      const rangeStr = opts.lines.trim();
      const dashIdx = rangeStr.indexOf("-");
      if (dashIdx > 0) {
        const a = Number(rangeStr.slice(0, dashIdx));
        const b = Number(rangeStr.slice(dashIdx + 1));
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) {
          process.stderr.write(`cat: invalid --lines value: ${opts.lines}\n`);
          process.exit(1);
        }
        lineStart = a;
        lineEnd = b;
      } else {
        const a = Number(rangeStr);
        if (!Number.isInteger(a) || a < 1) {
          process.stderr.write(`cat: invalid --lines value: ${opts.lines}\n`);
          process.exit(1);
        }
        lineStart = a;
        lineEnd = a;
      }
    }

    try {
      const note = await readNote(resolvedPath);
      if (opts.json) {
        // Agent-friendly structured output. Includes full Note shape; callers
        // who only want body/frontmatter can pluck fields. --lines is honored
        // by slicing raw+body to the requested range before serializing.
        if (lineStart !== undefined) {
          const allLines = note.raw.split("\n");
          const start = lineStart - 1;
          const end = Math.min((lineEnd ?? lineStart) - 1, allLines.length - 1);
          note.raw = allLines.slice(start, end + 1).join("\n");
          note.body = note.raw; // best-effort: frontmatter block may be sliced off
        }
        process.stdout.write(JSON.stringify(note, null, 2) + "\n");
        return;
      }
      if (lineStart === undefined) {
        // Full file output (unchanged behaviour)
        process.stdout.write(note.raw);
        if (!note.raw.endsWith("\n")) process.stdout.write("\n");
      } else {
        const allLines = note.raw.split("\n");
        const start = lineStart - 1; // 0-indexed
        const end = Math.min((lineEnd ?? lineStart) - 1, allLines.length - 1);
        for (let i = start; i <= end; i++) {
          const lineNum = i + 1;
          const lineContent = allLines[i] ?? "";
          if (process.stdout.isTTY) {
            // Dim 1-indexed line number prefix in TTY
            process.stdout.write(
              `${color(String(lineNum).padStart(4), c.dim)}  ${lineContent}\n`,
            );
          } else {
            process.stdout.write(`${lineContent}\n`);
          }
        }
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command("new")
  .description(
    "Create a new note. With --upsert, overwrites if the path exists (idempotent).",
  )
  .argument("<path>", "KB-relative path")
  .option("--title <title>", "frontmatter title")
  // --tags accepts a comma list; --tag is repeatable. Agents tend to guess
  // `--tag a --tag b` first — support both so the first try succeeds.
  .option("--tags <tags>", "comma-separated tags (e.g. --tags a,b,c)")
  .option(
    "--tag <tag>",
    "add a tag (repeatable: --tag a --tag b)",
    (value: string, prev: string[] = []) => [...prev, value],
  )
  .option("--body <body>", "inline body (skips $EDITOR)")
  .option(
    "--upsert",
    "overwrite if the note already exists instead of erroring (idempotent re-runs)",
  )
  .action(
    async (
      notePath: string,
      opts: {
        title?: string;
        tags?: string;
        tag?: string[];
        body?: string;
        upsert?: boolean;
      },
    ) => {
      const fm: Record<string, unknown> = {};
      if (opts.title) fm.title = opts.title;

      // Merge --tags (comma list) and --tag (repeatable); dedupe.
      const tagSet = new Set<string>();
      if (opts.tags) {
        for (const t of opts.tags.split(",").map((s) => s.trim()).filter(Boolean)) {
          tagSet.add(t);
        }
      }
      if (opts.tag) {
        for (const t of opts.tag.map((s) => s.trim()).filter(Boolean)) {
          tagSet.add(t);
        }
      }
      if (tagSet.size > 0) fm.tags = Array.from(tagSet);

      // Guard against silent overwrite BEFORE opening the editor so we don't
      // waste an $EDITOR session when the check will fail anyway. writeNote()
      // in core/fs.ts is upsert by design; `kb new` stays a strict "create"
      // verb unless --upsert is passed.
      let exists = false;
      try {
        await readNote(notePath);
        exists = true;
      } catch {
        // readNote rejected because the path doesn't exist — safe to create.
      }
      if (exists && !opts.upsert) {
        fail(
          `note already exists: ${notePath} (pass --upsert to overwrite, or use a different path)`,
        );
      }

      let body = opts.body ?? "";
      if (!opts.body && stdin.isTTY) {
        const editor = process.env.EDITOR;
        if (editor) {
          const tmp = path.join(
            os.tmpdir(),
            `kb-${Date.now()}-${path.basename(notePath)}.md`,
          );
          await fs.writeFile(tmp, body, "utf8");
          const res = spawnSync(editor, [tmp], { stdio: "inherit" });
          if (res.status !== 0) fail("editor exited non-zero");
          body = await fs.readFile(tmp, "utf8");
          await fs.unlink(tmp).catch(() => {});
        }
      }

      try {
        const note = await writeNote({ path: notePath, body, frontmatter: fm });
        const verb = opts.upsert ? "upserted:" : "created:";
        process.stdout.write(`${color(verb, c.green)} ${note.path}\n`);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

program
  .command("rm")
  .description("Delete a note")
  .argument("<path>", "KB-relative path")
  .option("-y, --yes", "skip confirmation")
  .action(async (notePath: string, opts: { yes?: boolean }) => {
    if (!opts.yes && stdin.isTTY) {
      const rl = createInterface({ input: stdin, output: stdout });
      const ans = await rl.question(`delete ${notePath}? [y/N] `);
      rl.close();
      if (ans.trim().toLowerCase() !== "y") {
        process.stdout.write("aborted\n");
        return;
      }
    }
    try {
      await deleteNote(notePath);
      process.stdout.write(`${color("deleted:", c.yellow)} ${notePath}\n`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command("search")
  .description("Search notes. Use tag:<name> to filter by tag (AND across multiple).")
  .argument("<query...>", "search terms; tag:<name> filters by exact tag")
  .option("-n, --limit <n>", "max results", "20")
  .option("--json", "emit raw JSON array of SearchHit objects")
  .action(async (query: string[], opts: { limit: string; json?: boolean }) => {
    const hits = await searchNotes(query.join(" "), Number(opts.limit) || 20);

    if (opts.json) {
      process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
      return;
    }

    if (hits.length === 0) {
      process.stdout.write(color("(no hits)\n", c.dim));
      return;
    }
    for (const h of hits) {
      process.stdout.write(
        `${color(h.path, c.blue)}  ${color(h.title, c.bold)}  ${color(`(${h.score.toFixed(3)})`, c.dim)}\n`,
      );
      if (h.snippet) {
        process.stdout.write(`  ${color(h.snippet.replace(/\s+/g, " ").trim(), c.dim)}\n`);
      }
    }
  });

function printTree(node: TreeNode, prefix = "", isLast = true, isRoot = true) {
  if (isRoot) {
    if (node.name) {
      process.stdout.write(`${color(node.name + "/", c.blue)}\n`);
    }
  } else {
    const branch = isLast ? "└── " : "├── ";
    const name = node.type === "directory" ? color(node.name + "/", c.blue) : node.name;
    process.stdout.write(`${prefix}${branch}${name}\n`);
  }
  const nextPrefix = isRoot ? "" : prefix + (isLast ? "    " : "│   ");
  const children = node.children ?? [];
  children.forEach((child, i) => {
    printTree(child, nextPrefix, i === children.length - 1, false);
  });
}

program
  .command("tree")
  .description("Print the KB directory tree")
  .option("--json", "emit JSON TreeNode instead of the ASCII tree")
  .action(async (opts: { json?: boolean }) => {
    const t = await buildTree();
    if (opts.json) {
      process.stdout.write(JSON.stringify(t, null, 2) + "\n");
      return;
    }
    printTree(t);
  });

program
  .command("sync")
  .description("Sync with S3")
  .option("--push", "push only (upload local → S3)")
  .option("--pull", "pull only (download S3 → local)")
  .option("--mirror", "delete files on the target that don't exist on source")
  .option("--dry-run", "report what would happen, don't change anything")
  .action(
    async (opts: {
      push?: boolean;
      pull?: boolean;
      mirror?: boolean;
      dryRun?: boolean;
    }) => {
      let direction: "push" | "pull" | "both" = "both";
      if (opts.push && opts.pull) fail("--push and --pull are mutually exclusive");
      if (opts.push) direction = "push";
      else if (opts.pull) direction = "pull";

      try {
        const result = await sync({
          direction,
          mirror: opts.mirror,
          dryRun: opts.dryRun,
        });
        const tag = opts.dryRun ? color("[dry-run] ", c.yellow) : "";
        process.stdout.write(
          `${tag}${color("uploaded:", c.green)} ${result.uploaded.length}  ` +
            `${color("downloaded:", c.cyan)} ${result.downloaded.length}  ` +
            `${color("skipped:", c.dim)} ${result.skipped}\n`,
        );
        for (const f of result.uploaded) process.stdout.write(`  ↑ ${f}\n`);
        for (const f of result.downloaded) process.stdout.write(`  ↓ ${f}\n`);
        for (const f of result.deletedRemote) process.stdout.write(`  ✗remote ${f}\n`);
        for (const f of result.deletedLocally) process.stdout.write(`  ✗local  ${f}\n`);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

program
  .command("import")
  .description("Import markdown files from an external folder into the KB")
  .argument("<source>", "source folder path (~ expanded)")
  .option("--from <date>", "ISO date lower bound (inclusive)")
  .option("--to <date>", "ISO date upper bound (inclusive)")
  .option("--no-overwrite", "skip existing targets (default: overwrite)")
  .option("--dry-run", "print the plan without writing anything")
  .option(
    "--ignore <pattern>",
    "ignore pattern (repeatable; replaces defaults: .* node_modules *.bak *.tmp *.swp *~)",
    (val: string, acc: string[]) => {
      acc.push(val);
      return acc;
    },
    [] as string[],
  )
  .option("-y, --yes", "skip interactive confirmation")
  .action(
    async (
      source: string,
      opts: {
        from?: string;
        to?: string;
        overwrite?: boolean; // commander sets false when --no-overwrite is passed
        dryRun?: boolean;
        ignore?: string[];
        yes?: boolean;
      },
    ) => {
      // Expand ~ via os.homedir() (matches API route behavior for AC-19)
      let srcPath = source;
      if (srcPath === "~") {
        srcPath = os.homedir();
      } else if (srcPath.startsWith("~/")) {
        srcPath = path.join(os.homedir(), srcPath.slice(2));
      }

      // Parse --from / --to into Date instances
      let fromDate: Date | undefined;
      let toDate: Date | undefined;

      if (opts.from) {
        fromDate = new Date(opts.from);
        if (!Number.isFinite(fromDate.getTime())) {
          fail(`import: invalid --from date: ${opts.from}`);
        }
      }
      if (opts.to) {
        toDate = new Date(opts.to);
        if (!Number.isFinite(toDate.getTime())) {
          fail(`import: invalid --to date: ${opts.to}`);
        }
      }

      // commander's --no-overwrite sets opts.overwrite = false.
      // Absence of the flag leaves opts.overwrite = true (commander default for boolean).
      // We translate this to undefined→true at the core boundary.
      const overwrite = opts.overwrite === false ? false : undefined;

      // If --ignore appears at least once, its collected array replaces defaults.
      // Empty array (flag never used) → undefined → core uses defaults.
      const ignorePatterns =
        opts.ignore && opts.ignore.length > 0 ? opts.ignore : undefined;

      // Always dry-run first to build the preview (FR-17)
      let plan;
      try {
        plan = await importNotes({
          source: srcPath,
          from: fromDate,
          to: toDate,
          overwrite,
          dryRun: true,
          ignorePatterns,
        });
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }

      // Print dry-run summary (FR-18)
      const { counts } = plan;
      const dryPrefix = opts.dryRun ? color("[dry-run] ", c.dim) : "";
      process.stdout.write(
        `${dryPrefix}` +
          `planned: ${color(String(counts.planned), c.green)}  ` +
          `skipped(exists): ${color(String(counts.skippedExists), c.yellow)}  ` +
          `skipped(filter): ${color(String(counts.skippedFilter), c.yellow)}  ` +
          `ignored: ${color(String(counts.skippedIgnored), c.dim)}\n`,
      );

      // Print first 50 relevant entries (plan + skip-exists)
      const relevant = plan.entries.filter(
        (e) => e.status === "plan" || e.status === "skip-exists",
      );
      const shown = relevant.slice(0, 50);
      for (const e of shown) {
        if (e.status === "plan") {
          process.stdout.write(
            `  ${color("+", c.green)} ${color(e.targetRel, c.green)} (from ${e.dateSource})\n`,
          );
        } else {
          process.stdout.write(
            `  ${color("-", c.yellow)} ${color(e.targetRel, c.yellow)} (skip-exists)\n`,
          );
        }
      }
      if (relevant.length > 50) {
        process.stdout.write(
          `  ${color(`... and ${relevant.length - 50} more`, c.dim)}\n`,
        );
      }

      // If --dry-run, exit here
      if (opts.dryRun) {
        process.exit(0);
      }

      // Interactive confirmation
      if (!process.stdin.isTTY && !opts.yes) {
        fail("import: non-TTY, use --yes to confirm");
      }

      if (!opts.yes) {
        const rl = createInterface({ input: stdin, output: stdout });
        const ans = await rl.question(
          `import ${counts.planned} files? [y/N] `,
        );
        rl.close();
        if (ans.trim().toLowerCase() !== "y") {
          process.stdout.write(color("aborted\n", c.dim));
          process.exit(0);
        }
      }

      // Execute the import
      try {
        const result = await importNotes({
          source: srcPath,
          from: fromDate,
          to: toDate,
          overwrite,
          dryRun: false,
          ignorePatterns,
        });
        const { counts: rc } = result;
        process.stdout.write(
          `planned: ${color(String(rc.planned), c.green)}  ` +
            `skipped(exists): ${color(String(rc.skippedExists), c.yellow)}  ` +
            `skipped(filter): ${color(String(rc.skippedFilter), c.yellow)}  ` +
            `ignored: ${color(String(rc.skippedIgnored), c.dim)}\n`,
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

// ---------------------------------------------------------------------------
// Tiny relative-time formatter. No external deps.
// < 60s → "Xs", < 60m → "Xm", < 24h → "Xh", < 30d → "Xd", else "Xw"
// ---------------------------------------------------------------------------
function relTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.round(diffMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  return `${Math.round(d / 7)}w`;
}

program
  .command("info")
  .description("Show KB statistics (note count, size, top folders/tags, recent)")
  .option("--top <n>", "how many top folders/tags to show", "10")
  .option("--recent <n>", "how many recent notes to show", "5")
  .option("--json", "emit raw JSON instead of human-readable output")
  .action(async (opts: { top: string; recent: string; json?: boolean }) => {
    const topN = Number(opts.top) || 10;
    const recentN = Number(opts.recent) || 5;
    let stats;
    try {
      stats = await kbStats({ topN, recentN });
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
      return;
    }

    // Human-readable output — ANSI colours matching existing commands.
    const sizeMb = (stats.totalSize / 1_048_576).toFixed(2);
    const lastWrite = stats.lastUpdated
      ? ` (last write ${relTime(stats.lastUpdated)} ago)`
      : "";
    const lastDate = stats.lastUpdated
      ? stats.lastUpdated.slice(0, 10)
      : "—";

    process.stdout.write(
      `${color("KB root:", c.bold)} ${color(stats.kbRoot, c.blue)} ${color(`(source: ${stats.source})`, c.dim)}\n` +
      `${color("Notes:", c.bold)}   ${stats.noteCount}\n` +
      `${color("Size:", c.bold)}    ${sizeMb} MB\n` +
      `${color("Updated:", c.bold)} ${lastDate}${color(lastWrite, c.dim)}\n`,
    );

    if (stats.topFolders.length > 0) {
      process.stdout.write(`\n${color("Top folders:", c.bold)}\n`);
      const maxCount = stats.topFolders.reduce(
        (mx, f) => Math.max(mx, f.count),
        0,
      );
      const countWidth = String(maxCount).length;
      for (const f of stats.topFolders) {
        process.stdout.write(
          `  ${color(f.folder.padEnd(24), c.blue)}  ${color(String(f.count).padStart(countWidth), c.dim)}\n`,
        );
      }
    }

    if (stats.topTags.length > 0) {
      process.stdout.write(`\n${color("Top tags:", c.bold)}\n`);
      const maxCount = stats.topTags.reduce(
        (mx, t) => Math.max(mx, t.count),
        0,
      );
      const countWidth = String(maxCount).length;
      for (const t of stats.topTags) {
        process.stdout.write(
          `  ${color(("#" + t.tag).padEnd(24), c.cyan)}  ${color(String(t.count).padStart(countWidth), c.dim)}\n`,
        );
      }
    }

    if (stats.recent.length > 0) {
      process.stdout.write(
        `\n${color(`Recent (last ${stats.recent.length} writes):`, c.bold)}\n`,
      );
      for (const r of stats.recent) {
        process.stdout.write(
          `  ${color(relTime(r.mtime).padEnd(4), c.dim)}  ${color(r.path, c.blue)}\n`,
        );
      }
    }
  });

// ---------------------------------------------------------------------------
// Tiny glob-to-regex converter. Supports *, **, ?. No new deps.
// ---------------------------------------------------------------------------
function globToRegex(glob: string): RegExp {
  // Escape regex metachars except * and ?, which we handle specially.
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      re += ".*"; // ** matches across path separators
      i++;        // skip the second *
      // consume a trailing slash so "**/" doesn't produce ".*/" with a required /
      if (glob[i + 1] === "/") i++;
    } else if (ch === "*") {
      re += "[^/]*"; // single * does not cross directory boundaries
    } else if (ch === "?") {
      re += "[^/]"; // ? matches exactly one non-separator char
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += "\\" + ch; // escape regex metachars
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$", "i");
}

program
  .command("find")
  .description(
    "Search notes by filename / path. Auto-detects glob if the pattern " +
      "contains *, ?, or [...]; otherwise treats it as a case-insensitive substring. " +
      "Use --substring or --glob to force a mode.",
  )
  .argument("<pattern>", "pattern to match against KB-relative paths")
  .option("--glob", "force glob mode (supports *, **, ?, [abc])")
  .option("--substring", "force substring mode (disables auto-detection)")
  .option("--json", "emit JSON array of note summaries")
  .action(
    async (
      pattern: string,
      opts: { glob?: boolean; substring?: boolean; json?: boolean },
    ) => {
      let notes;
      try {
        notes = await listNotes(); // already sorted mtime desc
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }

      // Auto-detect: a pattern containing any glob metachar becomes glob mode
      // unless the user forced --substring. Fixes the "user tries *summary*
      // expecting a match, gets zero hits" footgun called out by agents.
      const hasGlobMeta = /[*?[]/.test(pattern);
      const useGlob = opts.glob || (hasGlobMeta && !opts.substring);

      let hits;
      if (useGlob) {
        const re = globToRegex(pattern);
        hits = notes.filter((n) => re.test(n.path));
      } else {
        const lower = pattern.toLowerCase();
        hits = notes.filter((n) => n.path.toLowerCase().includes(lower));
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
        return;
      }

      if (hits.length === 0) {
        process.stdout.write(color("(no matches)\n", c.dim));
        return;
      }

      for (const h of hits) {
        process.stdout.write(
          `${color(h.path, c.blue)}  ${color(h.title, c.bold)}\n`,
        );
      }
    },
  );

// ---------------------------------------------------------------------------
// Seed file names that are excluded from orphan output by default.
// Match is against the KB-relative path string exactly (case-sensitive).
// ---------------------------------------------------------------------------
const ORPHAN_SEED_EXCLUSIONS = new Set(["welcome.md", "README.md"]);

program
  .command("backlinks")
  .description(
    "Show notes that link to <path>. Supports [[wiki]] and [text](path.md) links.",
  )
  .argument("<path>", "KB-relative path of the target note")
  .option("--json", "emit raw JSON array of LinkRef objects")
  .action(async (notePath: string, opts: { json?: boolean }) => {
    // Normalize: append .md if missing.
    const target = notePath.endsWith(".md") ? notePath : `${notePath}.md`;

    let index;
    try {
      index = await buildLinkIndex();
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }

    const refs = index.inbound.get(target) ?? [];

    if (opts.json) {
      process.stdout.write(JSON.stringify(refs, null, 2) + "\n");
      return;
    }

    if (refs.length === 0) {
      process.stdout.write(color("(no backlinks)\n", c.dim));
      return;
    }

    // Group by unique source path so a note linking to the target twice shows once.
    const bySource = new Map<string, typeof refs>();
    for (const ref of refs) {
      const existing = bySource.get(ref.from) ?? [];
      existing.push(ref);
      bySource.set(ref.from, existing);
    }

    // Build a path → title lookup so we can show the source note title next to
    // its path — scans better than raw paths alone (dogfooding issue #4).
    const summaries = await listNotes();
    const titleByPath = new Map(summaries.map((s) => [s.path, s.title]));

    for (const [sourcePath, sourceRefs] of bySource) {
      // Show the first ref's raw link text; append count if multiple.
      const firstRaw = sourceRefs[0].raw;
      const kindLabel = sourceRefs[0].kind;
      const extra = sourceRefs.length > 1 ? ` (+${sourceRefs.length - 1} more)` : "";
      const title = titleByPath.get(sourcePath) ?? "";
      const titleCol = title ? `  ${color(title, c.bold)}` : "";
      process.stdout.write(
        `  ${color(sourcePath, c.blue)}${titleCol}    ${color(firstRaw, c.dim)} ${color(`(${kindLabel})`, c.cyan)}${color(extra, c.dim)}\n`,
      );
    }
  });

program
  .command("orphans")
  .description(
    "List notes with zero inbound links (no [[wiki]] or [text](path.md) references from other notes).",
  )
  .option("--all", "include seed files (welcome.md, README.md)")
  .option("--json", "emit JSON array of NoteSummary objects for the orphans")
  .action(async (opts: { all?: boolean; json?: boolean }) => {
    let notes;
    let index;
    try {
      [notes, index] = await Promise.all([listNotes(), buildLinkIndex()]);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }

    const orphans = notes.filter((n) => {
      // A note is an orphan if it has no inbound links.
      if ((index.inbound.get(n.path) ?? []).length > 0) return false;
      // Apply seed exclusion unless --all is passed.
      if (!opts.all && ORPHAN_SEED_EXCLUSIONS.has(n.path)) return false;
      return true;
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(orphans, null, 2) + "\n");
      return;
    }

    if (orphans.length === 0) {
      process.stdout.write(color("(no orphans)\n", c.dim));
      return;
    }

    for (const o of orphans) {
      process.stdout.write(
        `${color(o.path, c.blue)}  ${color(o.title, c.bold)}  ${color(`(${relTime(o.mtime)})`, c.dim)}\n`,
      );
    }
  });

program
  .command("broken")
  .description(
    "List broken links (target=null). Groups by source for human view; flat array for --json.",
  )
  .option("--json", "emit raw JSON array of LinkRef objects")
  .action(async (opts: { json?: boolean }) => {
    let index;
    try {
      index = await buildLinkIndex();
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }

    const broken = index.broken;

    if (opts.json) {
      process.stdout.write(JSON.stringify(broken, null, 2) + "\n");
      return;
    }

    if (broken.length === 0) {
      process.stdout.write(color("(no broken links)\n", c.dim));
      return;
    }

    // Group by source path — same style as backlinks command.
    const bySource = new Map<string, typeof broken>();
    for (const ref of broken) {
      const existing = bySource.get(ref.from) ?? [];
      existing.push(ref);
      bySource.set(ref.from, existing);
    }

    for (const [sourcePath, refs] of bySource) {
      process.stdout.write(`${color(sourcePath, c.blue)}\n`);
      for (const ref of refs) {
        process.stdout.write(
          `  ${color(ref.raw, c.dim)}  ${color(`(${ref.kind})`, c.cyan)}\n`,
        );
      }
    }
  });

// ---------------------------------------------------------------------------
// kb reindex — rebuild the semantic embedding sidecar (T6)
// ---------------------------------------------------------------------------

program
  .command("reindex")
  .description("Rebuild the semantic embedding index (incremental by default)")
  .option("--force", "rebuild every row from scratch (re-embed all notes)")
  .action(async (opts: { force?: boolean }) => {
    if (opts.force) {
      // Full rebuild with per-note progress indicator.
      const isTTY = process.stderr.isTTY;
      let lastLen = 0;

      const onProgress = (done: number, total: number, notePath: string) => {
        const msg = `[${done}/${total}] ${notePath}`;
        if (isTTY) {
          // Overwrite the same line via carriage return.
          process.stderr.write(`\r${msg.padEnd(lastLen)}`);
          lastLen = msg.length;
        } else {
          process.stderr.write(`${msg}\n`);
        }
      };

      let result;
      try {
        result = await rebuildIndex(onProgress);
      } catch (e) {
        if (isTTY) process.stderr.write("\n");
        process.stderr.write(
          `${color("reindex failed:", c.red)} ${e instanceof Error ? e.message : String(e)}\n`
        );
        process.exit(1);
      }

      if (isTTY) process.stderr.write("\n"); // newline after progress line
      process.stdout.write(
        `${color("indexed:", c.green)} ${result.indexed}  ` +
          `${color("skipped:", c.yellow)} ${result.skipped}  ` +
          `${color("time:", c.dim)} ${(result.durationMs / 1000).toFixed(1)}s\n`
      );
    } else {
      // Incremental refresh.
      let result;
      try {
        result = await refreshIndex();
      } catch (e) {
        process.stderr.write(
          `${color("reindex failed:", c.red)} ${e instanceof Error ? e.message : String(e)}\n`
        );
        process.exit(1);
      }
      process.stdout.write(
        `${color("added:", c.green)} ${result.added}  ` +
          `${color("updated:", c.cyan)} ${result.updated}  ` +
          `${color("removed:", c.yellow)} ${result.removed}\n`
      );
    }
  });

program
  .command("mcp")
  .description("Start the MCP server (stdio)")
  .action(() => {
    // Resolve tsx from this package's node_modules (NOT from PATH) so the
    // subcommand works after `pnpm link --global` the same way bin/kb.mjs
    // and bin/mcp.mjs do. Using `spawn("tsx", ...)` would rely on tsx being
    // in PATH, which is not guaranteed in a global-install context.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgRoot = path.resolve(here, "../..");
    const tsxBin = path.join(pkgRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const serverPath = path.join(pkgRoot, "src", "mcp", "server.ts");
    const child = spawn(process.execPath, [tsxBin, serverPath], {
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

// ---------------------------------------------------------------------------
// kb organize — auto-organize KB notes into topical folders.
//
// Dry-run by default (no flags → print plan, exit 0).
// Filesystem is NEVER mutated without --apply.
// ---------------------------------------------------------------------------

/** Collect repeatable --exclude flags into an array. */
function collectExclude(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

// ---------------------------------------------------------------------------
// Pretty TTY output helpers for organize
// ---------------------------------------------------------------------------

/** Print the dry-run / plan TTY output. */
function printOrganizePlan(
  plan: OrganizePlan,
  opts: { verbose?: boolean }
): void {
  const { verbose } = opts;

  // Header
  process.stdout.write(
    `${color("kb organize", c.bold)} ${color("—", c.dim)} ${color("dry-run", c.yellow)}\n`
  );
  process.stdout.write(
    `${color("Total notes scanned:", c.dim)} ${plan.stats.total}\n\n`
  );

  // Summary block: counts by reason
  process.stdout.write(`${color("Summary:", c.bold)}\n`);
  process.stdout.write(
    `  ${color("by type:", c.dim)}      ${color(String(plan.stats.byType), c.green)}\n` +
    `  ${color("by tag:", c.dim)}       ${color(String(plan.stats.byTag), c.cyan)}\n` +
    `  ${color("by cluster:", c.dim)}   ${color(String(plan.stats.byCluster), c.magenta)}\n` +
    `  ${color("unassigned:", c.dim)}   ${color(String(plan.stats.unassigned), c.dim)}\n` +
    `  ${color("moves planned:", c.dim)} ${color(String(plan.moves.length), c.bold)}\n\n`
  );

  // Per-cluster section
  if (plan.clusters.length > 0) {
    process.stdout.write(`${color("Clusters:", c.bold)}\n`);
    for (const cl of plan.clusters) {
      process.stdout.write(
        `  ${color(cl.folder + "/", c.blue)}  ` +
        `${color(`${cl.memberCount} notes`, c.dim)}  ` +
        `${color(`[${cl.topTerms.slice(0, 3).join(", ")}]`, c.cyan)}\n`
      );

      // Member list: show first 5 titles (or all with --verbose)
      const clusterMoves = plan.moves.filter((m) => m.clusterLabel === cl.folder);
      const shown = verbose ? clusterMoves : clusterMoves.slice(0, 5);
      for (const m of shown) {
        process.stdout.write(`    ${color("→", c.dim)} ${color(m.from, c.dim)} → ${color(m.to, c.blue)}\n`);
      }
      if (!verbose && clusterMoves.length > 5) {
        process.stdout.write(
          `    ${color(`… and ${clusterMoves.length - 5} more`, c.dim)}\n`
        );
      }
    }
    process.stdout.write("\n");
  }

  // Per-note moves grouped by target folder (verbose: all; otherwise first 10 per group)
  if (plan.moves.length > 0) {
    // Group moves by the first segment of the target path (top-level folder)
    const byFolder = new Map<string, OrganizeMove[]>();
    for (const move of plan.moves) {
      const folder = move.to.split("/")[0] ?? move.to;
      const existing = byFolder.get(folder) ?? [];
      existing.push(move);
      byFolder.set(folder, existing);
    }

    if (!verbose && byFolder.size > 0) {
      process.stdout.write(`${color("Planned moves (grouped by target):", c.bold)}\n`);
      for (const [folder, moves] of byFolder) {
        process.stdout.write(`  ${color(folder + "/", c.blue)} ${color(`(${moves.length})`, c.dim)}\n`);
        const shown = moves.slice(0, 10);
        for (const m of shown) {
          process.stdout.write(
            `    ${color(m.from, c.dim)} → ${color(m.to, c.green)}  ${color(`(${m.reason})`, c.cyan)}\n`
          );
        }
        if (moves.length > 10) {
          process.stdout.write(`    ${color(`… and ${moves.length - 10} more`, c.dim)}\n`);
        }
      }
      process.stdout.write("\n");
    } else if (verbose) {
      process.stdout.write(`${color("Planned moves (all):", c.bold)}\n`);
      for (const m of plan.moves) {
        process.stdout.write(
          `  ${color(m.from, c.dim)} → ${color(m.to, c.green)}  ${color(`(${m.reason}, conf=${m.confidence.toFixed(2)})`, c.cyan)}\n`
        );
      }
      process.stdout.write("\n");
    }
  }

  // Link-rewrite preview
  const rewriteFiles = new Set(plan.rewrites.map((r) => r.file)).size;
  process.stdout.write(
    `${color("Link rewrites:", c.dim)} would rewrite ${color(String(plan.rewrites.length), c.bold)} references in ${color(String(rewriteFiles), c.bold)} files\n\n`
  );

  // Footer
  process.stdout.write(
    `${color("Run with", c.dim)} ${color("--apply", c.yellow)} ${color("to execute, or", c.dim)} ${color("--json", c.yellow)} ${color("for machine-readable output.", c.dim)}\n`
  );
}

/** Handle OrganizeError and unexpected errors uniformly. */
function handleOrganizeError(
  e: unknown,
  jsonMode: boolean
): never {
  const msg = e instanceof Error ? e.message : String(e);
  const isKnown = e instanceof OrganizeError;
  const showStack = process.env.KB_DEBUG === "1";

  if (jsonMode) {
    // --json mode: stdout gets JSON error envelope; stderr gets human message.
    process.stderr.write(`${color("error:", c.red)} ${msg}\n`);
    process.stdout.write(JSON.stringify({ error: msg }) + "\n");
  } else {
    process.stderr.write(`${color("error:", c.red)} ${msg}\n`);
    if (!isKnown && showStack && e instanceof Error && e.stack) {
      process.stderr.write(e.stack + "\n");
    }
  }
  process.exit(1);
}

program
  .command("organize")
  .description(
    "Auto-organize KB notes into topical folders. Dry-run by default — no changes until --apply."
  )
  // Execution mode flags (mutually exclusive in practice; --undo wins if both supplied)
  .option("--apply", "execute the planned moves and link rewrites")
  .option("--undo", "reverse the most recent applied organize")
  // Output flags
  .option("--json", "emit plan/result as JSON (no ANSI, no prompts)")
  .option("--verbose", "show full per-note move list instead of grouped summary")
  // Tuning flags
  .option(
    "--exclude <glob>",
    "extra path glob to carve out (repeatable)",
    collectExclude,
    [] as string[]
  )
  .option("--no-rewrite-links", "skip the link-rewrite pass")
  .option("--min-confidence <n>", "cluster-confidence threshold (default 0.35)")
  .option("--max-clusters <n>", "upper bound on cluster count (default auto)")
  .option("--keep-empty-dirs", "don't sweep empty parent dirs after moves")
  .option("--no-llm", "skip all LLM tiers (TF-IDF naming only)")
  .option("--no-ollama", "skip the Ollama tier (use Flan-T5 + TF-IDF only)")
  .option(
    "--model <name>",
    "Ollama model tag to use (default: $KB_ORGANIZE_MODEL or llama3.2:3b)"
  )
  .option(
    "--ollama-url <url>",
    "Ollama base URL (default: $KB_ORGANIZE_OLLAMA_URL or http://localhost:11434)"
  )
  .action(
    async (opts: {
      apply?: boolean;
      undo?: boolean;
      json?: boolean;
      verbose?: boolean;
      exclude?: string[];
      rewriteLinks?: boolean; // commander sets false when --no-rewrite-links used
      minConfidence?: string;
      maxClusters?: string;
      keepEmptyDirs?: boolean;
      llm?: boolean; // commander sets false when --no-llm is used
      ollama?: boolean; // commander sets false when --no-ollama is used
      model?: string;
      ollamaUrl?: string;
    }) => {
      const jsonMode = opts.json === true;
      const noLlm = opts.llm === false; // commander: --no-llm sets opts.llm = false
      const noOllama = opts.ollama === false; // commander: --no-ollama sets opts.ollama = false
      const ollamaModel = opts.model;
      const ollamaUrl = opts.ollamaUrl;
      const minConf =
        opts.minConfidence !== undefined ? Number(opts.minConfidence) : undefined;
      const maxClusters =
        opts.maxClusters !== undefined ? Number(opts.maxClusters) : undefined;

      // Validate numeric flags.
      if (minConf !== undefined && (Number.isNaN(minConf) || minConf < 0 || minConf > 1)) {
        process.stderr.write(`error: --min-confidence must be a number between 0 and 1\n`);
        process.exit(1);
      }
      if (maxClusters !== undefined && (!Number.isInteger(maxClusters) || maxClusters < 1)) {
        process.stderr.write(`error: --max-clusters must be a positive integer\n`);
        process.exit(1);
      }

      // --- UNDO mode ---
      if (opts.undo) {
        if (!jsonMode) {
          process.stdout.write(
            `${color("kb organize", c.bold)} ${color("—", c.dim)} ${color("undoing", c.yellow)}\n`
          );
        }
        try {
          const result = await undoLastOrganize();

          if (jsonMode) {
            process.stdout.write(JSON.stringify(result, null, 2) + "\n");
          } else {
            process.stdout.write(
              `${color("Reverted:", c.green)} ${result.reverted} operations.` +
              ` Ledger: ${color(result.ledgerPath, c.dim)}\n`
            );
            if (result.conflicts.length > 0) {
              process.stdout.write(
                `${color(`Conflicts: ${result.conflicts.length} (listed below)`, c.yellow)}\n`
              );
              for (const conflict of result.conflicts) {
                process.stdout.write(
                  `  ${color(conflict.path, c.dim)} — ${conflict.reason}\n`
                );
              }
            }
          }
          return;
        } catch (e) {
          handleOrganizeError(e, jsonMode);
        }
      }

      // --- DRY-RUN or APPLY: build the plan first ---
      let plan: OrganizePlan;
      try {
        plan = await buildOrganizePlan({
          mode: "full",
          exclude: opts.exclude ?? [],
          minConfidence: minConf,
          maxClusters,
          // commander sets opts.rewriteLinks = false when --no-rewrite-links is passed
          rewriteLinks: opts.rewriteLinks !== false,
          noLlm,
          noOllama,
          ollamaModel,
          ollamaUrl,
        });
      } catch (e) {
        // Map OrganizeError codes to user-friendly messages (spec §6).
        if (e instanceof OrganizeError) {
          if (e.code === "MISSING_INDEX_DIR" || e.code === "MISSING_SIDECAR") {
            const msg = "organize requires an embedding index — run `kb reindex` first.";
            if (jsonMode) {
              process.stdout.write(JSON.stringify({ error: msg }) + "\n");
            }
            process.stderr.write(`${color("error:", c.red)} ${msg}\n`);
            process.exit(1);
          }
          if (e.code === "LOCK_HELD") {
            const msg = `${e.message}. If stale, remove .kb-index/organize/.lock.`;
            if (jsonMode) {
              process.stdout.write(JSON.stringify({ error: msg }) + "\n");
            }
            process.stderr.write(`${color("error:", c.red)} ${msg}\n`);
            process.exit(1);
          }
        }
        handleOrganizeError(e, jsonMode);
      }

      // --- DRY-RUN (no --apply) ---
      if (!opts.apply) {
        if (jsonMode) {
          process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
        } else {
          printOrganizePlan(plan, { verbose: opts.verbose });
        }
        return;
      }

      // --- APPLY mode ---
      if (!jsonMode) {
        process.stdout.write(
          `${color("kb organize", c.bold)} ${color("—", c.dim)} ${color("applying", c.yellow)}\n`
        );
        process.stdout.write(
          `${color("Planning:", c.dim)} ${plan.moves.length} moves, ${plan.rewrites.length} link rewrites...\n`
        );
      }

      try {
        const result = await applyOrganizePlan(plan, {
          keepEmptyDirs: opts.keepEmptyDirs,
        });

        if (jsonMode) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          process.stdout.write(
            `${color("Applied:", c.green)} ${result.applied} moves, ` +
            `${color(String(plan.rewrites.length), c.cyan)} link rewrites.\n` +
            `${color("Ledger:", c.dim)} ${result.ledgerPath}\n` +
            `${color("Run", c.dim)} ${color("kb organize --undo", c.yellow)} ${color("to reverse.", c.dim)}\n`
          );

          if (result.skipped.length > 0) {
            process.stdout.write(
              `${color(`Skipped: ${result.skipped.length} (content changed since plan):`, c.yellow)}\n`
            );
            for (const m of result.skipped) {
              process.stdout.write(`  ${color(m.from, c.dim)} (not moved)\n`);
            }
          }
        }
      } catch (e) {
        // Map lock errors specifically.
        if (e instanceof OrganizeError && e.code === "LOCK_HELD") {
          const msg = `${e.message}. If stale, remove .kb-index/organize/.lock.`;
          if (jsonMode) {
            process.stdout.write(JSON.stringify({ error: msg }) + "\n");
          }
          process.stderr.write(`${color("error:", c.red)} ${msg}\n`);
          process.exit(1);
        }
        handleOrganizeError(e, jsonMode);
      }
    }
  );

// ---------------------------------------------------------------------------
// kb learn — generate per-cluster summary notes from the learnings pipeline.
//
// Dry-run by default (no flags → print plan, exit 0).
// Filesystem is NEVER mutated without --apply.
// ---------------------------------------------------------------------------

/** Collect repeatable --cluster flags into an array. */
function collectCluster(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

// ---------------------------------------------------------------------------
// Pretty TTY output helpers for learn
// ---------------------------------------------------------------------------

/** Status badge string for a cluster. */
function learnStatusBadge(status: LearnClusterPlan["status"]): string {
  switch (status) {
    case "new":     return color("[new]", c.green);
    case "stale":   return color("[stale]", c.yellow);
    case "fresh":   return color("[fresh]", c.dim);
    case "skipped": return color("[skip]", c.dim);
  }
}

/** Generator badge string for a cluster. */
function learnGeneratorBadge(generator: LearnClusterPlan["generator"]): string {
  return generator === "ollama"
    ? color("ollama", c.magenta)
    : color("extractive", c.cyan);
}

/** Print the dry-run / plan TTY output for learn. */
function printLearnPlan(plan: LearnPlan): void {
  // Header
  process.stdout.write(
    `${color("kb learn", c.bold)} ${color("—", c.dim)} ${color("dry-run", c.yellow)}\n`
  );

  // Stats summary
  const { stats } = plan;
  process.stdout.write(
    `${color("Clusters:", c.bold)} ` +
    `total=${color(String(stats.total), c.bold)}  ` +
    `new=${color(String(stats.new), c.green)}  ` +
    `stale=${color(String(stats.stale), c.yellow)}  ` +
    `fresh=${color(String(stats.fresh), c.dim)}  ` +
    `skipped=${color(String(stats.skipped), c.dim)}\n`
  );

  // Top-level generator
  process.stdout.write(
    `${color("Generator:", c.dim)} ${learnGeneratorBadge(plan.generator)}\n`
  );

  // Surface Ollama error if present
  if (plan.ollamaError) {
    process.stdout.write(
      `${color("Ollama:", c.yellow)} ${color(plan.ollamaError, c.dim)}\n`
    );
  }

  process.stdout.write("\n");

  // Per-cluster table (skip fresh clusters unless all are fresh)
  const activeClusters = plan.clusters.filter(
    (c) => c.status !== "fresh" && c.status !== "skipped"
  );
  const freshClusters = plan.clusters.filter((c) => c.status === "fresh");
  const skippedClusters = plan.clusters.filter((c) => c.status === "skipped");

  if (activeClusters.length > 0) {
    process.stdout.write(`${color("Pending:", c.bold)}\n`);
    for (const cl of activeClusters) {
      process.stdout.write(
        `  ${learnStatusBadge(cl.status)} ` +
        `${color(cl.cluster, c.blue)}  ` +
        `${color(`${cl.sources.length} notes`, c.dim)}  ` +
        `${learnGeneratorBadge(cl.generator)}\n`
      );
    }
    process.stdout.write("\n");
  }

  if (freshClusters.length > 0) {
    process.stdout.write(
      `${color(`Fresh (up-to-date, no writes needed): ${freshClusters.length}`, c.dim)}\n\n`
    );
  }

  if (skippedClusters.length > 0) {
    process.stdout.write(`${color("Skipped:", c.dim)}\n`);
    for (const cl of skippedClusters) {
      process.stdout.write(
        `  ${learnStatusBadge(cl.status)} ` +
        `${color(cl.cluster, c.dim)}  ` +
        `${color(cl.skipReason ?? "below minNotes threshold", c.dim)}\n`
      );
    }
    process.stdout.write("\n");
  }

  if (plan.clusters.length === 0) {
    process.stdout.write(
      `${color("(no eligible clusters found — add notes or lower --min-notes)", c.dim)}\n\n`
    );
  }

  // Footer
  process.stdout.write(
    `${color("Run with", c.dim)} ${color("--apply", c.yellow)} ` +
    `${color("to write summaries, or", c.dim)} ${color("--json", c.yellow)} ` +
    `${color("for machine-readable output.", c.dim)}\n`
  );
}

/** Handle LearnError and unexpected errors uniformly. */
function handleLearnError(e: unknown, jsonMode: boolean): never {
  const msg = e instanceof Error ? e.message : String(e);
  const isKnown = e instanceof LearnError;
  const showStack = process.env.KB_DEBUG === "1";

  if (jsonMode) {
    process.stderr.write(`${color("error:", c.red)} ${msg}\n`);
    process.stdout.write(JSON.stringify({ error: msg }) + "\n");
  } else {
    process.stderr.write(`${color("error:", c.red)} ${msg}\n`);
    if (!isKnown && showStack && e instanceof Error && e.stack) {
      process.stderr.write(e.stack + "\n");
    }
  }
  process.exit(1);
}

program
  .command("learn")
  .description(
    "Generate per-cluster summary notes (_summary.md). Dry-run by default — no changes until --apply."
  )
  // Execution mode flags (mutually exclusive in practice; --undo wins if both supplied)
  .option("--apply", "execute the plan: write/overwrite _summary.md files")
  .option("--undo", "reverse the most recent applied learn run")
  // Output flags
  .option("--json", "emit plan/result as JSON (no ANSI, no prompts)")
  // Generator tuning flags (mirror organize's --no-llm / --no-ollama / --model / --ollama-url)
  .option("--no-llm", "force extractive tier — skip Ollama entirely")
  .option("--no-ollama", "skip the Ollama tier (alias for --no-llm in v1)")
  .option(
    "--model <name>",
    "Ollama model tag to use (default: $KB_LEARN_MODEL or llama3.2)"
  )
  .option(
    "--ollama-url <url>",
    "Ollama base URL (default: $KB_LEARN_OLLAMA_URL or http://localhost:11434)"
  )
  .option("--force", "regenerate even if sourceHashes match (overrides idempotency skip)")
  .option(
    "--cluster <path>",
    "scope run to a single cluster folder (repeatable)",
    collectCluster,
    [] as string[]
  )
  .option(
    "--min-notes <n>",
    `cluster threshold — minimum notes per folder (default: $KB_LEARN_MIN_NOTES or 3)`
  )
  .action(
    async (opts: {
      apply?: boolean;
      undo?: boolean;
      json?: boolean;
      llm?: boolean;       // commander sets false when --no-llm is used
      ollama?: boolean;    // commander sets false when --no-ollama is used
      model?: string;
      ollamaUrl?: string;
      force?: boolean;
      cluster?: string[];
      minNotes?: string;
    }) => {
      const jsonMode = opts.json === true;
      // commander: --no-llm sets opts.llm = false; --no-ollama sets opts.ollama = false
      const noLlm =
        opts.llm === false ||
        opts.ollama === false ||
        process.env.KB_LEARN_NO_OLLAMA === "1";
      const ollamaModel =
        opts.model ?? process.env.KB_LEARN_MODEL;
      const ollamaUrl =
        opts.ollamaUrl ?? process.env.KB_LEARN_OLLAMA_URL;
      const force = opts.force ?? false;
      const scopedClusters =
        opts.cluster && opts.cluster.length > 0 ? opts.cluster : undefined;

      // Resolve minNotes (flag > env > default 3)
      let minNotes: number | undefined;
      if (opts.minNotes !== undefined) {
        const parsed = parseInt(opts.minNotes, 10);
        if (Number.isNaN(parsed) || parsed < 1) {
          process.stderr.write(`error: --min-notes must be a positive integer\n`);
          process.exit(1);
        }
        minNotes = parsed;
      } else if (process.env.KB_LEARN_MIN_NOTES) {
        const parsed = parseInt(process.env.KB_LEARN_MIN_NOTES, 10);
        if (!Number.isNaN(parsed) && parsed > 0) minNotes = parsed;
      }

      // --- UNDO mode ---
      if (opts.undo) {
        if (!jsonMode) {
          process.stdout.write(
            `${color("kb learn", c.bold)} ${color("—", c.dim)} ${color("undoing", c.yellow)}\n`
          );
        }
        try {
          const result = await undoLastLearn();

          if (jsonMode) {
            process.stdout.write(JSON.stringify(result, null, 2) + "\n");
          } else {
            process.stdout.write(
              `${color("Reverted", c.green)} ${result.restored} summaries` +
              ` (${result.conflicts.length} conflicts).` +
              ` Ledger: ${color(result.ledgerPath, c.dim)}\n`
            );
            if (result.conflicts.length > 0) {
              process.stdout.write(
                `${color(`Conflicts (${result.conflicts.length}):`, c.yellow)}\n`
              );
              for (const conflict of result.conflicts) {
                process.stdout.write(
                  `  ${color(conflict.path, c.dim)} — ${conflict.reason}\n`
                );
              }
            }
          }
          return;
        } catch (e) {
          if (e instanceof LearnError) {
            if (e.code === "NO_LEDGER") {
              const msg = "no learn ledger found — run 'kb learn --apply' first";
              if (jsonMode) process.stdout.write(JSON.stringify({ error: msg }) + "\n");
              process.stderr.write(`${color("error:", c.red)} ${msg}\n`);
              process.exit(1);
            }
            if (e.code === "LOCK_HELD") {
              const msg = `another learn is in progress. If stuck, remove .kb-index/learn/.lock`;
              if (jsonMode) process.stdout.write(JSON.stringify({ error: msg }) + "\n");
              process.stderr.write(`${color("error:", c.red)} ${msg}\n`);
              process.exit(1);
            }
          }
          handleLearnError(e, jsonMode);
        }
      }

      // --- DRY-RUN or APPLY: build the plan first ---
      let plan: LearnPlan;
      try {
        plan = await buildLearnPlan({
          clusters: scopedClusters,
          minNotes,
          noLlm,
          noOllama: noLlm,
          ollamaModel,
          ollamaUrl,
          force,
        });
      } catch (e) {
        if (e instanceof LearnError) {
          if (e.code === "LOCK_HELD") {
            const msg = `another learn is in progress. If stuck, remove .kb-index/learn/.lock`;
            if (jsonMode) process.stdout.write(JSON.stringify({ error: msg }) + "\n");
            process.stderr.write(`${color("error:", c.red)} ${msg}\n`);
            process.exit(1);
          }
        }
        handleLearnError(e, jsonMode);
      }

      // --- DRY-RUN (no --apply) ---
      if (!opts.apply) {
        if (jsonMode) {
          process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
        } else {
          printLearnPlan(plan);
        }
        return;
      }

      // --- APPLY mode ---
      if (!jsonMode) {
        const actionable = plan.clusters.filter(
          (c) => c.status === "new" || c.status === "stale"
        ).length;
        process.stdout.write(
          `${color("kb learn", c.bold)} ${color("—", c.dim)} ${color("applying", c.yellow)}\n`
        );
        process.stdout.write(
          `${color("Planning:", c.dim)} ${actionable} summaries to write...\n`
        );
      }

      try {
        const result = await applyLearnPlan(plan, {
          force,
          noLlm,
          noOllama: noLlm,
          ollamaModel,
          ollamaUrl,
        });

        if (jsonMode) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          process.stdout.write(
            `${color("Wrote", c.green)} ${result.applied.length} summaries` +
            ` (${color(String(result.skipped.length), c.dim)} skipped,` +
            ` ${color("0", c.dim)} conflicts).` +
            ` Ledger: ${color(result.ledgerPath, c.dim)}\n`
          );

          if (result.ollamaError) {
            process.stdout.write(
              `${color("Ollama:", c.yellow)} ${color(result.ollamaError, c.dim)}\n`
            );
          }

          if (result.skipped.length > 0) {
            process.stdout.write(
              `${color(`Skipped: ${result.skipped.length}`, c.yellow)}\n`
            );
            for (const s of result.skipped) {
              process.stdout.write(
                `  ${color(s.cluster, c.dim)} — ${s.reason}\n`
              );
            }
          }
        }
      } catch (e) {
        if (e instanceof LearnError && e.code === "LOCK_HELD") {
          const msg = `another learn is in progress. If stuck, remove .kb-index/learn/.lock`;
          if (jsonMode) process.stdout.write(JSON.stringify({ error: msg }) + "\n");
          process.stderr.write(`${color("error:", c.red)} ${msg}\n`);
          process.exit(1);
        }
        handleLearnError(e, jsonMode);
      }
    }
  );

// ---------------------------------------------------------------------------
// link-archive — wire imports/workspace/ into the link graph via
// `## Related from archive` blocks in cluster summaries.
// ---------------------------------------------------------------------------
program
  .command("link-archive")
  .description(
    "Add 'Related from archive' links to cluster summaries. " +
      "Dry-run by default — no changes until --apply. Use --undo to reverse.",
  )
  .option("--apply", "write the changes (default is preview only)")
  .option("--undo", "revert the most recent --apply run")
  .option("--top <n>", "top-K archive links per summary (default: 5)", "5")
  .option(
    "--archive-prefix <prefix>",
    "candidate pool path prefix (default: imports/workspace/)",
    "imports/workspace/",
  )
  .option("--json", "emit JSON plan / result instead of human-readable output")
  .action(
    async (opts: {
      apply?: boolean;
      undo?: boolean;
      top: string;
      archivePrefix: string;
      json?: boolean;
    }) => {
      const jsonMode = !!opts.json;

      if (opts.undo) {
        const { reverted, ledgerPath } = await undoLastLinkArchive();
        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({ reverted, ledgerPath }, null, 2) + "\n",
          );
          return;
        }
        if (reverted === 0) {
          process.stdout.write("(no link-archive runs to undo)\n");
          return;
        }
        process.stdout.write(
          `${color("reverted:", c.yellow)} ${reverted} summaries restored from ${ledgerPath}\n`,
        );
        return;
      }

      const topK = Number(opts.top) || 5;
      if (!Number.isFinite(topK) || topK < 1 || topK > 50) {
        fail(`invalid --top value: ${opts.top} (expected 1..50)`);
      }

      const plan: LinkArchivePlan = await buildLinkArchivePlan({
        topK,
        archivePrefix: opts.archivePrefix,
      });

      if (!opts.apply) {
        // Preview
        if (jsonMode) {
          // Trim the large base64 content fields for preview output; full
          // apply reloads content from disk anyway.
          const slim = {
            ...plan,
            edits: plan.edits.map((e) => ({
              summaryPath: e.summaryPath,
              cluster: e.cluster,
              clusterSize: e.clusterSize,
              unchanged: e.unchanged,
              links: e.links,
            })),
          };
          process.stdout.write(JSON.stringify(slim, null, 2) + "\n");
          return;
        }

        const changed = plan.edits.filter((e) => !e.unchanged);
        process.stdout.write(
          `${color("kb link-archive — preview", c.cyan)} ` +
            `(${changed.length} summaries would change, ${plan.edits.length - changed.length} unchanged, ${plan.skipped.length} skipped)\n\n`,
        );
        for (const edit of changed) {
          process.stdout.write(
            `${color(edit.summaryPath, c.blue)}  ${color(`(${edit.links.length} links, cluster size ${edit.clusterSize})`, c.dim)}\n`,
          );
          for (const link of edit.links) {
            process.stdout.write(
              `  ${color("→", c.dim)} ${link.path}  ${color(`cos=${link.cosine.toFixed(3)}`, c.dim)}\n`,
            );
          }
        }
        if (plan.skipped.length > 0) {
          process.stdout.write(`\n${color("skipped:", c.dim)}\n`);
          for (const s of plan.skipped.slice(0, 10)) {
            process.stdout.write(`  ${s.summaryPath}  (${s.reason})\n`);
          }
          if (plan.skipped.length > 10) {
            process.stdout.write(
              `  ... and ${plan.skipped.length - 10} more\n`,
            );
          }
        }
        process.stdout.write(
          `\nRe-run with ${color("--apply", c.yellow)} to write.\n`,
        );
        return;
      }

      // Apply
      try {
        const result = await applyLinkArchivePlan(plan);
        if (jsonMode) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
          return;
        }
        process.stdout.write(
          `${color("applied:", c.green)} ${result.edits} summaries updated, ${result.skipped} unchanged.\n`,
        );
        process.stdout.write(`Ledger: ${result.ledgerPath}\n`);
        process.stdout.write(`Run ${color("kb link-archive --undo", c.dim)} to reverse.\n`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (jsonMode) process.stdout.write(JSON.stringify({ error: msg }) + "\n");
        fail(msg);
      }
    },
  );

program.parseAsync(process.argv).catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
});
