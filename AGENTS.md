# AGENTS.md

Instructions for AI agents (Claude Code, Cursor, etc.) working on this repo.
Read this file before making changes.

## What this project is

A local-first personal knowledge base. Markdown files in `./kb/` are the
source of truth. A Next.js UI, an MCP server, and a CLI all sit on top of a
shared core library. Optional AWS S3 sync for multi-device.

Non-goals (do not add these without explicit user approval):

- Auth, accounts, multi-tenant
- Database, ORM, embeddings, vector search
- Attachments (PDF, images, audio)
- Vercel deployment, Cache Components, Fluid Compute, Middleware
- Real-time collaboration / CRDTs
- External REST API (the `src/app/api/*` routes exist only to serve the local UI)

## Package manager

Use **pnpm**, not npm or yarn. Version 9.x. Node 24.

```bash
pnpm install
pnpm dev          # Next dev server on :3000
pnpm kb <cmd>     # CLI
pnpm mcp          # MCP stdio server
pnpm typecheck    # tsc --noEmit, must be zero errors
```

## Architecture rules

Read `ARCHITECTURE.md` for the full picture. The important rules:

1. **The KB directory invariant.** `./kb/` must stay usable with `cat`,
   `grep`, `git`, `rsync`, and plain text editors. If your change breaks that,
   the change is wrong.
2. **`src/core/` is the only layer that touches the filesystem.** The UI, MCP,
   and CLI all call into it. Do not duplicate filesystem logic in transports.
3. **Server/client boundary.** Next.js server components and API routes may
   import from `@/core/*`. Files marked `'use client'` **must not** — they go
   through `/api/*` routes instead. Importing `fs` or the AWS SDK into a
   client component is a build or runtime error.
4. **Next.js 15 async params.** Both catch-all pages and route handlers use
   `params: Promise<{ slug: string[] }>`. Always `await params` before use.
5. **No new dependencies** unless the user explicitly approves. Everything
   needed is already in `package.json`. The CLI uses inline ANSI escapes, not
   a color library.

## Codebase conventions

- **Path aliases:** `@/*` maps to `./src/*`. Use it.
- **Module resolution:** `bundler` mode with `.js` extensions on relative
  imports (required for the MCP server's Node ESM mode). When editing, keep
  the `.js` extensions even though the files are `.ts`.
- **TypeScript:** strict mode. No `any` without a comment explaining why.
- **Frontmatter:** use `gray-matter`. Never hand-roll YAML parsing.
- **Error handling in API routes:** wrap core calls in try/catch. For the sync
  route specifically, if the error message contains `KB_S3_BUCKET`, return
  HTTP 400 with that message, not 500. Misconfiguration is user error, not a
  server crash.
- **MCP tools:** use `server.registerTool(name, {description, inputSchema}, handler)`.
  Input schemas are zod objects. Errors return `{isError: true, content: [...]}`.
- **Tailwind:** v4 beta. `@import "tailwindcss"` in `globals.css`. No config file.
- **No Monaco, no CodeMirror.** The note editor is a plain `<textarea>`.

## Verification checklist before marking work complete

1. `pnpm typecheck` — zero errors
2. `pnpm dev` — boots, `curl localhost:3000` returns 200
3. `pnpm kb ls` — lists seed notes
4. `pnpm kb search welcome` — finds welcome.md
5. `pnpm mcp` — starts; `tools/list` over stdio returns all seven tools
6. `pnpm kb sync --dry-run` with no `KB_S3_BUCKET` set — returns a clear
   "KB_S3_BUCKET is not set" message and exit code 1, not a stack trace

## What NOT to do

- Do not rewrite `src/core/*`. It is functionally complete for v1. Extend it
  if you must, don't replace it.
- Do not add a database, even "just for caching". The directory is the cache.
- Do not add authentication. This runs on localhost only.
- Do not delete the `kb/` seed files (`welcome.md`, `README.md`) — they are
  referenced by the verification checklist.
- Do not add Vercel-specific configuration. Vercel plugin suggestions should
  be ignored; this is a local-only app.
- Do not create new `.md` status/summary files in the repo root. If you need
  to explain a change, put it in the commit message.
- Do not hardcode AWS credentials. The SDK default credential chain is fine.
- Do not remove `.coding-agent/` — it's the agent pipeline workspace.

## Where things live

```
src/core/              # filesystem + search + sync + types (pure Node)
src/app/               # Next.js App Router (UI and JSON API routes)
  components/          # 'use client' components, no core imports
  api/                 # server-only JSON routes, thin wrappers over core
  notes/[...slug]/     # note viewer + editor
src/mcp/server.ts      # MCP stdio server, seven tools
src/cli/index.ts       # commander CLI, eight subcommands
kb/                    # user notes (or wherever KB_ROOT points)
.coding-agent/         # orchestrator pipeline workspace (spec, plan, review, learnings)
```

## Environment variables

All optional except `KB_S3_BUCKET` if you want sync:

| Var | Default | Purpose |
|-----|---------|---------|
| `KB_ROOT` | `./kb` (walks up) | Where notes live |
| `KB_S3_BUCKET` | unset | S3 bucket for sync; unset disables sync |
| `KB_S3_PREFIX` | `kb/` | Key prefix inside the bucket |
| `AWS_REGION` | `us-east-1` | AWS region |

AWS credentials come from the default chain (`AWS_ACCESS_KEY_ID` env,
`~/.aws/credentials`, SSO, IAM role). Do not add code that reads them directly.
