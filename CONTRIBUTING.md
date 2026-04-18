# Contributing

Thanks for your interest in contributing to `personal-knowledge-base`.

This project is small, opinionated, and optimized for a single person's daily
use — plus anyone else who wants a local-first markdown KB with agent access.
We welcome bug reports, polish PRs, and focused features that don't break the
"the filesystem is the source of truth" invariant documented in
[AGENTS.md](./AGENTS.md).

## Ground rules

- **The KB must stay `cat`/`grep`/`git`/`rsync`-able.** If a change moves logic
  into a database, a vendor API, or an opaque binary format, it's off-strategy
  for this project.
- **Conventions live in [AGENTS.md](./AGENTS.md).** Read it before proposing
  architecture changes.
- **No tracked `.env*` files** except `.env.example`. The CI and evaluator
  both check this.

## Dev setup

Requirements:

- **Node.js** `>=24` — this project uses the native test runner and ESM-first
  features that landed in 24.
- **pnpm** `>=9`

```bash
git clone https://github.com/devjarus/personal-knowledge-base.git
cd personal-knowledge-base
pnpm install
cp .env.example .env.local   # optional — edit KB_ROOT if you have an existing KB
```

Common scripts:

```bash
pnpm dev          # Next.js dev server on http://localhost:3000
pnpm test         # tsx --test 'tests/**/*.test.ts'
pnpm typecheck    # tsc --noEmit
pnpm build        # next build (sanity-check before PRs)
pnpm kb <cmd>     # run the CLI against $KB_ROOT or ./kb
pnpm mcp          # start the MCP server (stdio)
```

### Running the CLI or MCP against a throwaway KB

```bash
export KB_ROOT=/tmp/kb-test
mkdir -p "$KB_ROOT"
pnpm kb new hello.md --title "Hello" --body "world"
pnpm kb ls
```

Set `KB_ROOT` back when you're done — or don't, and let it fall back to `./kb`.

## Commit conventions

The repo follows a Conventional-Commits-ish style. Scan `git log --oneline` for
examples. Prefixes in use:

- `feat(scope):` — new feature
- `fix(scope):` — bug fix
- `chore(scope):` — tooling, test, or infra work
- `docs(scope):` — documentation only
- `refactor(scope):` — no behavior change

Keep messages short, lowercase, and scope-qualified where possible.

## PR expectations

Before opening a PR:

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] No tracked `.env*` other than `.env.example`
- [ ] [AGENTS.md](./AGENTS.md) conventions respected (core/ doesn't import from app/, etc.)
- [ ] No unrelated formatting-only noise in the diff

CI (`.github/workflows/ci.yml`) runs the same three commands on every PR. If
CI is red, the PR won't land.

## Lint

The project does not yet ship an ESLint config. Adding one is welcome — it's
explicitly out of scope for the 0.1 release but a good first PR. For now, rely
on TypeScript's strict mode and manual consistency with neighboring files.

## Releasing

Maintainers only. Steps for cutting a new version:

1. Update `CHANGELOG.md` — move items from `[Unreleased]` into a new
   `## [X.Y.Z] — YYYY-MM-DD` block. Keep the Keep-a-Changelog groupings
   (Added / Changed / Fixed / Removed / Security).
2. Bump the version:
   ```bash
   pnpm version patch   # or minor / major
   ```
   This updates `package.json`, creates a commit, and tags `vX.Y.Z`.
3. Push the commit and the tag:
   ```bash
   git push && git push --tags
   ```
4. The `.github/workflows/release.yml` workflow fires on the `v*` tag, runs
   the build, extracts the matching `CHANGELOG.md` block, and publishes a
   GitHub Release automatically. No manual `gh release create` needed.

## Canonical references

- [AGENTS.md](./AGENTS.md) — architecture, invariants, file layout, coding rules
- [README.md](./README.md) — user-facing overview
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) — community standards
- [CHANGELOG.md](./CHANGELOG.md) — release history
- [LICENSE](./LICENSE) — MIT

## Questions

Open a GitHub issue with the `question` label. For bug reports and feature
requests, use the corresponding issue template.
