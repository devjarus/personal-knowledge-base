# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-04-17

### Added

- Semantic search with local embeddings and hybrid keyword + vector ranking
- Backlinks panel in the note viewer; `kb backlinks` and `kb orphans` CLI commands
- Tag queries in search via `tag:<name>` syntax
- Miller-column browser in the web UI with folder and bulk-delete support
- Auto-organize pipeline (`kb organize`): four-phase tag-first + embedding-cluster
  approach with Ollama → Flan-T5-small → TF-IDF naming chain (Phases 1–4)
- Local Ollama model naming for cluster folders (`kb organize --model`)
- Learnings pipeline (`kb learn`): per-cluster `_summary.md` generation
  (Ollama → extractive fallback) with apply/undo and idempotency via source hashes
- `/learnings` and `/stats` pages in the web UI
- Bulk markdown import feature: CLI (`kb import`), API route, and `/import` page
- Empty-trash UI button in the sidebar footer
- `kb info` and `kb find` commands for corpus stats and filename lookup
- MCP server with seven tools: `list_notes`, `read_note`, `write_note`,
  `delete_note`, `search_notes`, `sync_kb`, `get_tree`
- Initial CLI (`kb`) and web UI (Next.js 15, shadcn/ui, dark mode, Cmd+K palette)
- Package as installable CLI + MCP with project-scoped agent wiring (`.mcp.json`)

### Changed

- CLI ergonomics: upsert semantics, repeatable tags, auto-glob, more `--json` flags
- Tests moved to top-level `tests/` directory mirroring `src/` layout
- Test discovery switched to glob pattern (`tests/**/*.test.ts`) instead of
  hand-enumerated file list
- Runtime-configurable KB location via env var → config → walk-up fallback chain
- `listNotes` cache + lazy body reads for faster search and tree builds
- CLI auto-loads `.env.local` for local dev convenience

### Fixed

- Soft-delete now moves files to `.trash/` instead of calling `fs.unlink`
- P0 dogfooding fixes: `kb mcp` startup, tree key generation, frontmatter date
  handling, post-import tree refresh
- P2 polish: ignore patterns, re-auth hint, `--json` consistency, `kb cat` slicing
- Miscellaneous dogfooding issues surfaced in 2026-04-13 session (link-graph,
  workspace imports, search edge cases)

[Unreleased]: https://github.com/devjarus/personal-knowledge-base/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/devjarus/personal-knowledge-base/releases/tag/v0.1.0
