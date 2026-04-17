#!/usr/bin/env tsx
/**
 * Personal KB — MCP server
 *
 * Stdio transport. Exposes the local knowledge base as MCP tools so any
 * MCP-compatible agent (Claude Desktop, Claude Code, Cursor, etc.) can read
 * and write notes the same way the web UI and CLI do.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { z } from "zod";

import {
  listNotes,
  readNote,
  writeNote,
  deleteNote,
  buildTree,
} from "../core/fs";
import { searchNotes } from "../core/search";
import { sync } from "../core/sync";

const server = new McpServer(
  {
    name: "personal-kb",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "Personal knowledge base — user's notes, context, long-term memory. " +
      "All notes are markdown files with YAML frontmatter, stored locally and " +
      "optionally synced to S3. Use list_notes/get_tree to discover, search_notes " +
      "to find, read_note to fetch, write_note to create or update.",
  },
);

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `error: ${msg}` }],
  };
}

server.registerTool(
  "list_notes",
  {
    description:
      "List all notes in the knowledge base as summaries (path, title, tags, mtime, preview). Sorted newest first.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await listNotes());
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.registerTool(
  "read_note",
  {
    description:
      "Read a single note by its KB-relative path (e.g. 'projects/kb.md'). Returns frontmatter + body.",
    inputSchema: {
      path: z.string().describe("KB-relative path, e.g. 'inbox/idea.md'"),
    },
  },
  async ({ path }) => {
    try {
      return jsonResult(await readNote(path));
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.registerTool(
  "write_note",
  {
    description:
      "Create or update a note. Auto-touches the 'updated' frontmatter field. Creates parent directories as needed.",
    inputSchema: {
      path: z.string().describe("KB-relative path"),
      body: z.string().describe("Markdown body (without frontmatter)"),
      frontmatter: z
        .record(z.unknown())
        .optional()
        .describe("Optional YAML frontmatter object"),
    },
  },
  async ({ path, body, frontmatter }) => {
    try {
      const note = await writeNote({ path, body, frontmatter });
      return jsonResult(note);
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.registerTool(
  "delete_note",
  {
    description: "Delete a note by KB-relative path.",
    inputSchema: {
      path: z.string(),
    },
  },
  async ({ path }) => {
    try {
      await deleteNote(path);
      return jsonResult({ ok: true, deleted: path });
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.registerTool(
  "search_notes",
  {
    description:
      "Full-text search across notes. Returns ranked hits with snippets. Title matches weight 3x, tag matches 2x, body matches 1x.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ query, limit }) => {
    try {
      return jsonResult(await searchNotes(query, limit ?? 30));
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.registerTool(
  "sync_kb",
  {
    description:
      "Sync the local KB with the configured S3 bucket. Two-way newest-wins by default. Requires KB_S3_BUCKET env var.",
    inputSchema: {
      direction: z.enum(["push", "pull", "both"]).optional(),
      mirror: z.boolean().optional().describe("Delete files on the target that don't exist on source"),
      dryRun: z.boolean().optional(),
    },
  },
  async ({ direction, mirror, dryRun }) => {
    try {
      const result = await sync({ direction, mirror, dryRun });
      return jsonResult(result);
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.registerTool(
  "get_tree",
  {
    description: "Get the KB directory tree (folders and notes).",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await buildTree());
    } catch (e) {
      return errorResult(e);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive on stdio.
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[kb-mcp] fatal:", err);
  process.exit(1);
});
