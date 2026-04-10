---
title: Welcome to your KB
tags: [welcome, getting-started]
type: note
created: 2026-04-10
updated: 2026-04-10
---

# Welcome to your KB

This is a sample note. It exists to prove the system works end-to-end and to
give you a template to copy.

## What you can do here

- **Write** — open this file in any editor, or use the web UI at `localhost:3000`,
  or `pnpm kb new path/to/note.md`.
- **Search** — `pnpm kb search welcome` finds this note. So does the search box
  in the sidebar of the web UI.
- **Tag** — add `tags: [foo, bar]` to the frontmatter and it shows up everywhere.
- **Move** — `mv welcome.md notes/welcome.md`. The KB is just files; nothing
  breaks.
- **Sync** — once you set `KB_S3_BUCKET`, `pnpm kb sync` mirrors this folder
  to S3.

## Why this exists

The pitch: a personal knowledge base that any agent or external plugin can use,
that you also enjoy editing by hand. No vendor lock-in. No database. No magic.
Just markdown files in a folder, with thin tooling on top.

> "Simple to work with but still usable." — the brief

## Next steps

1. Delete this note when you don't need it anymore (or move it to `notes/welcome.md`).
2. Read `README.md` for the conventions.
3. Wire the MCP server into your agent of choice.
4. Configure S3 sync if you want multi-device.
