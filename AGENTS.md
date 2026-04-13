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
pnpm kb <cmd>     # CLI (or `kb <cmd>` globally after `pnpm link --global`)
pnpm mcp          # MCP stdio server (or `kb-mcp` globally after link)
pnpm typecheck    # tsc --noEmit, must be zero errors
```

### Global install

`pnpm link --global` exposes two binaries: `kb` and `kb-mcp`. They are thin
loaders in `bin/kb.mjs` and `bin/mcp.mjs` that spawn `tsx` from the linked
repo's `node_modules` against `src/cli/index.ts` and `src/mcp/server.ts`
respectively. They resolve the package root via `import.meta.url`, NOT
`process.cwd()`, so they work from any directory. Do not change them to use
`process.cwd()` — that breaks global invocation.

`tsx` stays in `devDependencies`. `pnpm link --global` symlinks to the local
checkout, so devDeps are available. If this project ever publishes to npm,
`tsx` must move to `dependencies` OR the CLI/MCP must be precompiled to
`dist/`.

### Agent integration

`.mcp.json` at the repo root exposes the MCP server to any Claude Code session
opened in the repo (auto-discovered). It uses `pnpm mcp` as the command so it
works before `pnpm link --global`. `CLAUDE.md` is a 5-line redirect to this
file — single source of truth lives here, not there.

### Known limitation: CLI/MCP do not read `.env`

Only the Next.js UI loads `.env` automatically. `pnpm kb` and `pnpm mcp` (and
the global `kb` / `kb-mcp` bins) read env vars from the shell only. Set
`KB_ROOT`, `KB_S3_BUCKET`, etc. in `~/.zshrc` or pass them inline. This is a
real gap and fair game for a future task; until then, document it rather than
paper over it.

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
   a color library. *(v1.1 note: the shadcn/ui redesign added an approved
   batch — shadcn primitives, next-themes, @tailwindcss/typography,
   lucide-react, cmdk, sonner, the Radix deps they pull in, and
   tw-animate-css. Further additions still need explicit approval.)*

## Codebase conventions

- **Path aliases:** `@/*` maps to `./src/*`. Use it. shadcn extras:
  `@/components/ui` for primitives, `@/lib/utils` for `cn()`, `@/hooks` for
  shadcn hooks.
- **Module resolution:** `bundler` mode with `.js` extensions on relative
  imports (required for the MCP server's Node ESM mode). When editing, keep
  the `.js` extensions even though the files are `.ts`.
- **TypeScript:** strict mode. No `any` without a comment explaining why.
- **Frontmatter:** use `gray-matter`. Never hand-roll YAML parsing.
- **Error handling in API routes:** wrap core calls in try/catch. For the sync
  route specifically, if the error message contains `KB_S3_BUCKET`, return
  HTTP 400 with that message, not 500. Misconfiguration is user error, not a
  server crash.
- **Client-side error surfacing (F2 pattern).** When a client component
  handles a non-OK `fetch` response, parse the body as JSON inside a
  `try/catch` and surface `parsed.error` if present; fall back to raw text
  otherwise. This pattern appears in `sync-button.tsx`, `note-editor.tsx`
  (save + delete), and `notes/new/page.tsx`. Do not simplify it away.
- **User-facing feedback uses Sonner toasts**, not inline spans. `toast.success`
  for happy-path, `toast.error` with the parsed `.error` field for failures.
  Mount `<Toaster />` once in the root layout.
- **MCP tools:** use `server.registerTool(name, {description, inputSchema}, handler)`.
  Input schemas are zod objects. Errors return `{isError: true, content: [...]}`.
- **Tailwind:** v4. `@import "tailwindcss"` in `globals.css`. No config file.
  Theme tokens live in an `@theme inline` block mapping to OKLCH CSS vars in
  `:root` and `.dark`. Dark mode uses the `.dark` class (driven by
  next-themes), NOT the `@media (prefers-color-scheme: dark)` query.
- **shadcn/ui.** Style=new-york, baseColor=slate, CSS vars on. Never edit
  `src/components/ui/*` — if you need variants, compose them in wrapper
  components under `src/components/`. Use `cn()` from `@/lib/utils` for
  conditional classNames.
- **Dark mode.** `next-themes` with `attribute="class"`, `defaultTheme="system"`,
  `enableSystem`, `disableTransitionOnChange`. Root `<html>` MUST have
  `suppressHydrationWarning`. The ModeToggle lives in the top bar.
- **Cmd+K palette.** `src/components/command-palette.tsx` is loaded via
  `dynamic(... { ssr: false })` from `command-palette-loader.tsx` (client
  boundary — Next 15 forbids `ssr: false` in server components).
- **Note editor.** Still a shadcn `<Textarea>` — no Monaco, no CodeMirror.
  Delete confirmation uses `<AlertDialog>`, NOT `window.confirm`.
- **Route group.** Shell-wrapped pages live under `src/app/(shell)/`. The
  root `src/app/layout.tsx` only hosts the ThemeProvider + Toaster. If a
  future route (e.g. an onboarding page) shouldn't have the sidebar, put it
  outside the `(shell)` group.

## Verification checklist before marking work complete

1. `pnpm typecheck` — zero errors
2. `pnpm build` — zero warnings; First Load JS for `/notes/[...slug]` under
   200 kB (currently ~178 kB after the shadcn redesign)
3. `pnpm dev` — boots, `curl localhost:3000` returns 200 (the dev server
   may fall back to 3001 if 3000 is in use; check the "Ready" line)
4. `pnpm kb ls` — lists seed notes
5. `pnpm kb search welcome` — finds welcome.md
6. `pnpm kb tree` — indented tree (not flat) — F1 regression check
7. `pnpm mcp` — starts; `tools/list` over stdio returns all seven tools
8. `pnpm kb sync --dry-run` with no `KB_S3_BUCKET` set — returns a clear
   "KB_S3_BUCKET is not set" message and exit code 1, not a stack trace
9. The Sync button in the top bar (with no `KB_S3_BUCKET`) shows a Sonner
   toast reading exactly `KB_S3_BUCKET is not set. Configure it in .env to
   enable sync.` — NOT raw JSON (F2 regression check)

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
bin/                       # tiny Node loaders for global install (no deps)
  kb.mjs                   # → tsx src/cli/index.ts
  mcp.mjs                  # → tsx src/mcp/server.ts (binary name: kb-mcp)
.mcp.json                  # project-scoped MCP config, auto-loaded by Claude Code
CLAUDE.md                  # redirect to AGENTS.md (Claude Code looks for this name)
.nvmrc                     # Node version pin (24)
src/core/                  # filesystem + search + sync + types (pure Node)
src/app/                   # Next.js App Router
  layout.tsx               # root: ThemeProvider + Toaster, no shell
  globals.css              # Tailwind v4 + shadcn slate OKLCH vars + @plugin typography
  (shell)/                 # route group: shell-wrapped pages
    layout.tsx             # SidebarProvider + AppSidebar + TopBar + SidebarInset
    page.tsx               # home: recent notes as cards
    notes/new/page.tsx     # create-note form (shadcn Input/Textarea)
    notes/[...slug]/       # note viewer + editor (server component)
  api/                     # server-only JSON routes, thin wrappers over core
src/components/            # feature components (not shadcn primitives)
  app-sidebar.tsx          # Sidebar wrapper: header (logo + SearchBox), content (TreeNav), footer, rail
  top-bar.tsx              # sticky top bar: SidebarTrigger, Separator, New note, SyncButton, ModeToggle
  tree-nav.tsx             # recursive SidebarMenu, uses usePathname for isActive
  search-box.tsx           # shadcn Input + absolute results dropdown, 150ms debounce
  note-editor.tsx          # Edit/Preview toggle, Save, Delete via AlertDialog, Sonner toasts
  sync-button.tsx          # Dry-run/Sync buttons, Sonner toasts, F2 parsing (load-bearing)
  command-palette.tsx      # Cmd+K CommandDialog, /api/search + actions
  command-palette-loader.tsx # client boundary for dynamic({ssr:false}) import
  mode-toggle.tsx          # DropdownMenu with Light/Dark/System
  theme-provider.tsx       # next-themes wrapper
  ui/                      # shadcn primitives — DO NOT EDIT
src/lib/utils.ts           # cn() helper
src/hooks/                 # shadcn hooks (e.g. useMobile)
src/mcp/server.ts          # MCP stdio server, seven tools
src/cli/index.ts           # commander CLI, eight subcommands
components.json            # shadcn config
kb/                        # user notes (or wherever KB_ROOT points)
.coding-agent/             # orchestrator pipeline workspace (spec, plan, review, learnings)
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
