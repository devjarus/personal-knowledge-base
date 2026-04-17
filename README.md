# personal-knowledge-base

A local-first personal knowledge base. Plain markdown files in a folder. A
small Next.js web UI on top. An MCP server so any agent can read and write it.
A `kb` CLI for shell users. Optional S3 sync for multi-device.

> Source of truth is the filesystem. The KB must stay `cat`/`grep`/`git`/`rsync`-able.
> If a feature breaks that invariant, the feature is wrong.

## Why

Existing knowledge tools are heavyweight, lock you in, hide your data behind
an API, or all three. This one doesn't. Your notes live in `./kb/` as
markdown. You can edit them with `vim`, browse them with `cat`, version them
with `git`, and let agents work on them via MCP — all at the same time.

## Quickstart

```bash
pnpm install
pnpm dev
# open http://localhost:3000
```

The home page lists recent notes. Click `welcome.md` to read or edit it. The
sidebar has a search box, a tree view, and sync buttons.

## Install globally (optional)

After `pnpm install`, link the package so `kb` and `kb-mcp` work from any directory:

```bash
pnpm link --global
```

Now:

```bash
cd ~/anywhere
export KB_ROOT=~/notes/kb      # or put this in ~/.zshrc
kb ls
kb search project
kb-mcp                          # stdio MCP server
```

`pnpm link --global` works on private packages — it just symlinks to this
checkout. Uninstall with `pnpm uninstall --global personal-knowledge-base`.

> **Note:** The CLI and MCP server do NOT currently read `.env` — only the
> Next.js UI does. When running `kb` from outside the repo, set `KB_ROOT`
> (and `KB_S3_BUCKET` if you use sync) in your shell environment, not in `.env`.

## Configuration

Copy `.env.example` to `.env` and edit:

```bash
KB_ROOT=./kb              # or ~/Documents/kb to live outside this repo
KB_S3_BUCKET=             # leave blank to disable sync
KB_S3_PREFIX=kb/
AWS_REGION=us-east-1
```

`KB_ROOT` accepts an absolute or relative path. If unset, the system walks
upward from the current directory looking for a `kb/` folder, falling back to
`./kb`.

## S3 sync

Set `KB_S3_BUCKET` and you're done — AWS credentials resolve via the standard
chain (env vars, `~/.aws/credentials`, SSO). Then:

```bash
pnpm kb sync --dry-run    # see what would happen
pnpm kb sync              # two-way sync, newest wins
pnpm kb sync --push       # local → S3 only
pnpm kb sync --pull       # S3 → local only
pnpm kb sync --mirror     # also delete files missing on the source side
```

### Minimum IAM policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/kb/*"
    }
  ]
}
```

Adjust the prefix to match `KB_S3_PREFIX`.

## MCP server

`pnpm mcp` starts a stdio MCP server exposing seven tools: `list_notes`,
`read_note`, `write_note`, `delete_note`, `search_notes`, `sync_kb`, `get_tree`.

### Claude Code (project-scoped, auto-loaded)

If you open this repo in Claude Code, the MCP server is already wired up via
`.mcp.json` at the repo root. No config needed — the `list_notes`, `read_note`,
`search_notes`, etc. tools are available immediately.

After `pnpm link --global` you can optionally change `.mcp.json` to use
`"command": "kb-mcp", "args": []`, but the `pnpm mcp` form works without linking.

For Claude Desktop, Cursor, or Claude Code sessions outside the repo, add the
following to your MCP config:

### Claude Desktop / Cursor / Claude Code (outside repo)

Add to your MCP config (path varies — Claude Desktop is
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "personal-kb": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/personal-knowledge-base", "mcp"],
      "env": {
        "KB_ROOT": "/absolute/path/to/personal-knowledge-base/kb"
      }
    }
  }
}
```

Then in Claude/Cursor, the tools `list_notes`, `read_note`, etc. become
available. Try: *"Search my KB for notes tagged 'project'."*

## CLI reference

```bash
pnpm kb ls [prefix]                       # list notes
pnpm kb cat <path>                        # print raw contents
pnpm kb new <path> [--title=...] [--tags=a,b] [--body=...]
pnpm kb rm <path> [--yes]                 # delete (confirms unless --yes)
pnpm kb search <query>                    # full-text search
pnpm kb tree                              # print directory tree
pnpm kb sync [--push|--pull] [--mirror] [--dry-run]
pnpm kb import <source> [--from <date>] [--to <date>] [--no-overwrite] [--dry-run] [-y]
pnpm kb organize [--apply|--undo] [--no-llm] [--json]
                                          # cluster notes into topical folders (Ollama → TF-IDF)
pnpm kb learn [--apply|--undo] [--no-llm] [--json]
                                          # generate per-folder _summary.md (Ollama → extractive)
pnpm kb mcp                               # start MCP server
```

`kb new` will open `$EDITOR` if you're in a TTY and don't pass `--body`.

### Bulk import

Copy markdown files from an external folder into the KB:

```bash
kb import ~/Documents/obsidian-vault --from 2026-01-01 --dry-run
kb import ~/Documents/obsidian-vault --from 2026-01-01 --yes
```

Flags:
- `--from <date>` / `--to <date>` — ISO date bounds (inclusive). Resolved
  against frontmatter `updated`, else `created`, else file mtime.
- `--no-overwrite` — skip existing targets instead of overwriting.
  Default is overwrite.
- `--dry-run` — print the plan without writing anything.
- `-y`, `--yes` — skip the interactive confirmation prompt.

Imported files land under `kb/imports/<source-basename>/...` with
`imported_from` and `imported_at` frontmatter fields added. Existing
`created` / `updated` fields are preserved.

The UI also exposes bulk import at `/import` — fill in the source path,
optionally set a date range, preview the plan, then click Import.

## Frontmatter schema

All optional. The system respects them when present:

```yaml
---
title: Free-form title (overrides filename and H1)
tags: [tag-one, tag-two]
type: note | project | journal | reference  # free-form
created: 2026-04-10
updated: 2026-04-10  # auto-bumped on every save
---
```

## Project layout

```
src/
  core/        # types, fs, frontmatter, search, sync, paths — pure Node, no React
  app/         # Next.js App Router (UI + JSON API routes for the UI)
  mcp/         # stdio MCP server
  cli/         # commander CLI
kb/            # YOUR notes live here (or wherever KB_ROOT points)
```

The `core/` layer is the only thing that touches the filesystem. The web UI,
MCP server, and CLI all sit on top of it. They share zero state — they're
three different transports for the same operations.

## Non-goals

- Auth, accounts, multi-tenant
- Database, vector search, embeddings
- Attachments (PDFs, images, audio)
- Realtime collaboration / CRDTs
- Vercel deployment (this is local-only)
