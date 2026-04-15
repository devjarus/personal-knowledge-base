#!/usr/bin/env tsx
/**
 * `kb` CLI — thin commander wrapper around the core library.
 */
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
} from "../core/fs.js";
import { searchNotes } from "../core/search.js";
import { sync } from "../core/sync.js";
import { importNotes } from "../core/import.js";
import { kbStats } from "../core/stats.js";
import { buildLinkIndex } from "../core/links.js";
import { rebuildIndex, refreshIndex } from "../core/semanticIndex.js";
import type { TreeNode } from "../core/types.js";

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
  .action(async (notePath: string, opts: { lines?: string }) => {
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
  .description("Create a new note")
  .argument("<path>", "KB-relative path")
  .option("--title <title>", "frontmatter title")
  .option("--tags <tags>", "comma-separated tags")
  .option("--body <body>", "inline body (skips $EDITOR)")
  .action(
    async (
      notePath: string,
      opts: { title?: string; tags?: string; body?: string },
    ) => {
      const fm: Record<string, unknown> = {};
      if (opts.title) fm.title = opts.title;
      if (opts.tags)
        fm.tags = opts.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);

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
        process.stdout.write(`${color("created:", c.green)} ${note.path}\n`);
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
  .action(async () => {
    const t = await buildTree();
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
  .description("Search notes by filename / path (substring or glob)")
  .argument("<pattern>", "pattern to match against KB-relative paths")
  .option("--glob", "treat pattern as a glob (supports *, **, ?)")
  .option("--json", "emit JSON array of note summaries")
  .action(async (pattern: string, opts: { glob?: boolean; json?: boolean }) => {
    let notes;
    try {
      notes = await listNotes(); // already sorted mtime desc
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }

    let hits;
    if (opts.glob) {
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
  });

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

program.parseAsync(process.argv).catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
});
