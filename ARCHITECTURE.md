# Architecture

Plain-markdown personal KB with four transports on a single filesystem core. No
database. No server state. No auth.

## Invariant

> The KB directory is the source of truth. It must remain readable and
> writable by `cat`, `grep`, `git`, `rsync`, `find`, `vim`, and any text
> editor. If a change breaks that, the change is wrong.

Every design decision below descends from this invariant.

## Layers

```
┌───────────────────────────────────────────────────────────────────┐
│                            Transports                            │
│                                                                   │
│   Next.js UI        MCP server         CLI (commander)            │
│   (src/app)         (src/mcp)          (src/cli)                  │
│       │                 │                  │                     │
│       │ fetch /api/*    │ stdio JSON-RPC   │ direct import       │
│       ▼                 ▼                  ▼                     │
│   ┌───────────────────────────────────────────────────────────┐  │
│   │                   Core library (src/core)                 │  │
│   │  paths · frontmatter · fs · search · sync · types         │  │
│   └───────────────────────────────────────────────────────────┘  │
│                               │                                  │
│                               ▼                                  │
│                     ./kb/ (markdown files)                       │
│                               │                                  │
│                               ▼                                  │
│                     AWS S3 (optional, opt-in)                    │
└───────────────────────────────────────────────────────────────────┘
```

### `src/core/` — the only layer that touches the filesystem

| File | Responsibility |
|------|----------------|
| `types.ts` | `Note`, `NoteSummary`, `Frontmatter`, `TreeNode`, `SearchHit` |
| `paths.ts` | `kbRoot()` (env + walk-up), `resolveNotePath()` with traversal guard, `toRelPath()`, `withMarkdownExt()` |
| `frontmatter.ts` | Parse and serialize YAML frontmatter via `gray-matter`, plus `deriveTitle()` fallback |
| `fs.ts` | `listNotes`, `readNote`, `writeNote` (auto-bumps `updated`), `deleteNote`, `buildTree` |
| `search.ts` | Naive in-memory full-text search: title×3, tag×2, body×1, with snippet extraction |
| `sync.ts` | S3 two-way sync, newest-wins + ETag/MD5 dedup, optional mirror deletion, dry-run |

This layer is pure Node. No React, no Next, no commander, no MCP. Any of the
transports above can be replaced without touching it.

### `src/app/` — Next.js App Router

- **Root layout** (`src/app/layout.tsx`) hosts only the next-themes
  `ThemeProvider` and the Sonner `<Toaster />`. `<html suppressHydrationWarning>`
  is required so next-themes can flip the `.dark` class before React hydrates
  without triggering a hydration mismatch.
- **Shell route group** (`src/app/(shell)/`) wraps shell-bearing pages in a
  shadcn `<SidebarProvider>` + `<AppSidebar />` + `<SidebarInset><TopBar />
  {children}</SidebarInset>` tree, plus a lazy-loaded `<CommandPaletteLoader />`.
  If a future route (e.g. onboarding, landing page) shouldn't have the shell,
  place it outside the `(shell)` group.
- **Server components** (`page.tsx`, `notes/[...slug]/page.tsx`) import
  directly from `@/core/*` and run on the server only.
- **Client components** (`'use client'`) never import core — they talk to
  API routes. Non-OK responses are parsed as JSON and surfaced through
  Sonner toasts using the F2 pattern (see AGENTS.md).
- **API routes** under `src/app/api/*` are thin JSON wrappers over core functions:
  - `GET/POST /api/notes`
  - `GET/PUT/DELETE /api/notes/[...slug]` (async params, Next 15)
  - `GET /api/search?q=`
  - `POST /api/sync`
  - `GET /api/tree`
- **UI layer** is shadcn/ui (style=new-york, baseColor=slate). Primitives
  under `src/components/ui/` are CLI-generated and must not be edited; feature
  components compose them under `src/components/`.
- **Theming.** OKLCH CSS variables for both `:root` (light) and `.dark` (dark),
  mapped to Tailwind tokens via an `@theme inline` block. Dark mode is driven
  by next-themes toggling the `.dark` class on `<html>`. No
  `@media (prefers-color-scheme: dark)` query — that's replaced by user
  preference with `system` as the default.
- **Command palette.** `src/components/command-palette.tsx` hosts `cmdk` via
  shadcn's `<CommandDialog>`, loaded through a `dynamic(..., { ssr: false })`
  import inside a client-component wrapper (`command-palette-loader.tsx`).
  This pattern is required because Next 15 forbids `ssr: false` in server
  components. The palette is code-split into its own chunk so it doesn't hit
  the First Load JS of any route.
- **Styling.** Tailwind v4 via `@import "tailwindcss"` in `globals.css`. No
  `tailwind.config.js`. Typography via `@plugin "@tailwindcss/typography"`;
  rendered markdown uses `prose prose-slate dark:prose-invert max-w-none`.

### `src/mcp/server.ts` — MCP stdio server

- `McpServer` from `@modelcontextprotocol/sdk` over `StdioServerTransport`.
- Seven tools: `list_notes`, `read_note`, `write_note`, `delete_note`,
  `search_notes`, `sync_kb`, `get_tree`.
- Input schemas use `zod`. Errors return `isError: true` with a text message.
- Same core functions as the UI; no business logic here.

### `src/cli/index.ts` — CLI (commander)

Subcommands: `ls`, `cat`, `new`, `rm`, `search`, `tree`, `sync`, `mcp`. ANSI
colors via inline escapes (no color library). Non-zero exit on errors.

## Data model

Notes are markdown files. Path on disk is the identity. Example:

```markdown
---
title: Welcome to your KB
tags: [welcome, getting-started]
created: 2026-04-10
updated: 2026-04-10
---

# Welcome

Your first note.
```

`writeNote` auto-touches `updated` on every save. No other fields are magic.
The frontmatter is free-form — unknown keys round-trip untouched.

## Sync model

Explicit (`kb sync` or UI button), not continuous. Algorithm:

1. List local files (`kb/**/*.md`) with mtimes and MD5s.
2. List S3 objects under `KB_S3_PREFIX` with ETags (which are MD5s for
   non-multipart uploads) and `LastModified`.
3. For each path:
   - Both sides have same MD5 → skip (dedup).
   - Only on one side → copy to the other (respecting `direction`).
   - Different content → newest mtime wins.
4. If `--mirror`, delete files on the target that don't exist on source.
5. `--dry-run` computes the plan without executing it.

Single-user multi-device. Not a CRDT. If you save on two devices between syncs
the older one loses.

## Security boundaries

- **Path traversal:** `resolveNotePath()` refuses paths that escape `kbRoot()`.
- **Client bundle isolation:** No `fs`, `@aws-sdk/*`, or `@/core/*` imports in
  `'use client'` files. Enforced by convention (server components and API
  routes are the only importers).
- **Credentials:** AWS creds resolve via the SDK default chain. Never
  hardcoded, never logged.
- **Auth:** There is none. This is a local-only app. Don't expose `next dev`
  to the internet.

## Non-goals (deliberately absent)

- Database / ORM
- Auth / multi-tenant
- Vector search / embeddings
- Attachments (PDF, images, audio)
- Real-time collaboration / CRDTs
- Vercel deployment; no Cache Components, no Fluid Compute, no Middleware
- External REST API (the Next.js API routes exist only to serve the local UI)

## Adding a new transport

To add, say, a TUI or a Raycast extension:

1. Import from `src/core/*`.
2. Do not add new filesystem or S3 code — extend `core/` instead if needed.
3. Do not add a database. The directory is the database.
4. Respect the invariant. If your feature requires a sidecar file that isn't
   `cat`/`grep`-able, put it under `.kb/` and make sure the KB still works
   without it.
