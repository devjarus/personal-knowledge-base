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

function printTree(node: TreeNode, prefix = "", isLast = true) {
  const branch = prefix === "" ? "" : isLast ? "└── " : "├── ";
  const name = node.type === "directory" ? color(node.name + "/", c.blue) : node.name;
  if (prefix !== "" || node.name) {
    process.stdout.write(`${prefix}${branch}${name}\n`);
  }
  const nextPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "│   ");
  const children = node.children ?? [];
  children.forEach((child, i) => {
    printTree(child, nextPrefix, i === children.length - 1);
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
