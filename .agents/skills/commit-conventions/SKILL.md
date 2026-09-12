---
name: commit-conventions
description: Commit message rules, pre-commit hooks, and lint-staged workflow for this repo. Use when committing changes, debugging a blocked commit, or investigating why a commit was rejected by Husky/commitlint.
---

# Commit Conventions

This repo enforces commit quality through three layers: **lint-staged** (format/lint on staged files), **check-types** (monorepo type-check), and **commitlint** (Conventional Commits). All run automatically via Husky hooks.

## Conventional Commits

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <subject>

[optional body]

[optional footer]
```

Allowed types (from `@commitlint/config-conventional`):

| Type | When |
|------|------|
| `feat` | New user-facing feature |
| `fix` | Bug fix |
| `refactor` | Code restructure without behavior change |
| `perf` | Performance improvement |
| `docs` | Documentation only |
| `test` | Adding / updating tests |
| `chore` | Tooling, deps, non-user changes |
| `ci` | CI pipeline changes |
| `style` | Formatting, no logic change |
| `build` | Build system / external deps |
| `revert` | Revert a previous commit |

Examples:

```
feat(blog): add RSS feed route
fix(i18n): handle missing translation keys in server components
chore(deps): bump astro to 7.1.6
docs: update AGENTS.md with new tooling packages
```

### Rules enforced

- Subject in imperative mood ("add", not "added" / "adds")
- No period at end of subject
- Subject ≤ 100 chars
- Type is lowercase
- Body (if present) separated from subject by blank line

## Pre-commit hook

`.husky/pre-commit` runs on every `git commit`:

```bash
bunx lint-staged
bun run check-types
```

**`lint-staged`** (`.lintstagedrc.json`): Biome `check --write` on staged `js`, `ts`, `jsx`, `tsx`, and `json` files; and `bun run lint:slop` (oxlint, anti-slop preset) on staged `js`, `cjs`, `mjs`, `ts`, `mts`, `tsx`, and `astro` files. Biome auto-fixes and re-stages, while oxlint only reports, so a rule hit aborts the commit until the code is fixed.

**`check-types`**: runs `tsc --noEmit` in every workspace. If TypeScript errors exist anywhere in the repository, the commit aborts.

## Commit-msg hook

`.husky/commit-msg` runs commitlint against the message. A malformed message aborts the commit.

## Typical failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "✖ subject may not be empty" | Missing or wrong type | Use `<type>: <subject>` |
| "✖ type must be one of …" | Typo in type | Use an allowed type from the table above |
| Biome errors "x file(s) with errors" | Unfixable lint issue | Run `bun run format:fix`, resolve manually, re-stage |
| oxlint "Found N warnings/errors" | An anti-slop rule hit a staged file | Run `bun run lint:slop`, fix the reported rule, re-stage |
| "Type error in …" | TypeScript failure somewhere in the monorepo | Run `bun run check-types` locally, fix |
| Hook didn't run | Husky not installed | Run `bun install` (triggers `prepare` script) |

## Workflow

```bash
# Stage specific files - never `git add -A` or `git add .`
git add packages/collector/src/cli.ts
git add packages/collector/package.json

# Commit (hooks run automatically)
git commit -m "feat(header): add language switcher"

# If the hook fails, the commit did NOT happen.
# Fix the issue, re-stage the fixed file, and commit again (NEW commit, not --amend)
```

## Never

- **Never** use `--no-verify` to bypass hooks. If a hook fails, fix the root cause.
- **Never** `git commit --amend` on commits that have been pushed.
- **Never** force-push to `main`.
- **Never** `git add -A` or `git add .` - risks leaking `.env`, secrets, or large binaries.

## Multi-line commit messages

For longer messages, use a HEREDOC to preserve formatting:

```bash
git commit -m "$(cat <<'EOF'
feat(blog): add markdown export endpoint

Adds /api/blog/[slug]/markdown route that returns the raw Markdown
source of a post so readers can copy it into their own tools.
EOF
)"
```
