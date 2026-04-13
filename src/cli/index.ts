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
  .action(async (prefix?: string) => {
    const notes = await listNotes();
    const filtered = prefix
      ? notes.filter((n) => n.path.startsWith(prefix.replace(/\/$/, "") + "/"))
      : notes;
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
  .description("Print a note's raw contents")
  .argument("<path>", "KB-relative path")
  .action(async (notePath: string) => {
    try {
      const note = await readNote(notePath);
      process.stdout.write(note.raw);
      if (!note.raw.endsWith("\n")) process.stdout.write("\n");
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
  .description("Search notes")
  .argument("<query...>", "search terms")
  .option("-n, --limit <n>", "max results", "20")
  .action(async (query: string[], opts: { limit: string }) => {
    const hits = await searchNotes(query.join(" "), Number(opts.limit) || 20);
    if (hits.length === 0) {
      process.stdout.write(color("(no hits)\n", c.dim));
      return;
    }
    for (const h of hits) {
      process.stdout.write(
        `${color(h.path, c.blue)}  ${color(h.title, c.bold)}  ${color(`(${h.score})`, c.dim)}\n`,
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

program
  .command("mcp")
  .description("Start the MCP server (stdio)")
  .action(() => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const serverPath = path.resolve(here, "../mcp/server.ts");
    const child = spawn("tsx", [serverPath], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program.parseAsync(process.argv).catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
});
