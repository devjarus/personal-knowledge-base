---
title: How this knowledge base works
tags: [meta, kb]
created: 2026-04-10
updated: 2026-04-10
---

# How this knowledge base works

This folder is **the source of truth**. It's just markdown files. You can:

- `cat` and `grep` it
- track it in `git`
- copy it with `rsync`
- sync it to S3 (`pnpm kb sync`)
- read/write it from any agent via the MCP server

If a tool you've added stops you from doing any of those, the tool is wrong.

## Directory conventions

There is no enforced layout. The skeleton folders are just suggestions:

- `inbox/` — fast capture, unsorted thoughts, things to file later
- `notes/` — distilled, refined notes
- `projects/` — anything tied to active work

You're free to add `journal/`, `people/`, `recipes/`, whatever. The KB doesn't care.

## Frontmatter schema

Every note may have a YAML frontmatter block. None of these are required, but
the system will respect them when present:

```yaml
---
title: Free-form title (overrides the filename and any H1)
tags: [tag-one, tag-two]
type: note | project | journal | reference  # free-form
created: 2026-04-10
updated: 2026-04-10
---
```

`writeNote` will auto-set `created` (once) and bump `updated` on every save.

## How agents access this

Two interfaces:

1. **MCP server** — `pnpm mcp` starts a stdio MCP server. Wire it into Claude
   Desktop, Claude Code, Cursor, etc. Tools: `list_notes`, `read_note`,
   `write_note`, `delete_note`, `search_notes`, `sync_kb`, `get_tree`.
2. **CLI** — `pnpm kb <subcommand>`. Same operations, plus `kb new` and `kb cat`.

The web UI at `localhost:3000` is just a convenient front end for humans.

## How sync works

`kb sync` does a two-way "newest wins" sync with an S3 bucket. It uses MD5/ETag
to skip files that already match, and `mtime` vs. `LastModified` to decide
which side wins on a conflict. There's no CRDT and no merge — if you edit the
same note on two devices between syncs, the older one loses.

For single-user multi-device use, that's the right tradeoff.

Set `KB_S3_BUCKET` (and optionally `KB_S3_PREFIX`, `AWS_REGION`) in `.env` to
enable. Without it, sync is disabled and the rest of the KB still works locally.
