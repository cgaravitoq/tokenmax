---
name: biome-lint
description: Biome 2.5 configuration, formatting, and lint rules for this repo. Use when running format/lint commands, fixing lint errors, adjusting rules, or adding ignore comments. Biome replaces ESLint + Prettier here.
---

# Biome Linting & Formatting

This repo uses [Biome](https://biomejs.dev) 2.5 as the sole formatter and the primary linter; oxlint 1.82 (`oxlint.config.mts`, `bun run lint:slop`, ultracite anti-slop preset) is the second linter and runs in lint-staged and CI. **There is no ESLint and no Prettier.** Configuration lives in root `biome.json`.

## Commands

```bash
# From the repo root - runs across all workspaces
bun run format       # biome check .                (dry-run: reports issues, no writes)
bun run format:fix   # biome check . --write        (auto-fix + format + organize imports)
```

## What Biome does in this repo

- **Formatter**: indent, line width, quote style, trailing commas
- **Linter**: catches bugs, style issues, accessibility, TypeScript pitfalls
- **Assist / organize imports**: sorts and groups imports automatically
- Runs on staged files via `lint-staged` (see `commit-conventions` skill)

## Configuration (`biome.json`)

Root config applies to every workspace. Key points:

- Indent style: tabs / spaces → check `biome.json` before assuming
- Line width + quote style inherited repo-wide
- TypeScript and Astro-aware rule set
- Biome assists enabled (auto organize imports)
- CI-only stricter rules can be toggled via `--error-on-warnings`

## Fixing issues

Most issues are auto-fixable:

```bash
bun run format:fix
```

For issues Biome can't fix (e.g. logic warnings), edit the file manually. Run `format:fix` again to re-check.

## Ignoring code

Prefer fixing over ignoring. When a rule genuinely doesn't fit:

```ts
// biome-ignore lint/suspicious/noExplicitAny: <reason>
const value: any = getUntyped();

// biome-ignore lint/style/useTemplate: <reason>
const msg = "a" + "b";
```

Always include a `<reason>`. A bare `biome-ignore` without justification should itself be flagged.

For whole files or directories, add a negated glob to `biome.json` → `files.includes`, which is the only ignore surface Biome 2.x has. There is no `files.ignore` and no `linter.ignore`.

```json
"files": { "includes": ["**", "!**/dist", "!apps/worker/worker-configuration.d.ts"] }
```

## Common rules encountered

These are enabled in this repository's `biome.json`. A `biome-ignore` for anything else is dead weight.

| Rule | Level | Meaning |
|------|-------|---------|
| `lint/correctness/noUnusedImports` | error | Remove imports nothing references |
| `lint/correctness/noUnusedVariables` | error | Remove bindings nothing reads |
| `lint/correctness/noUnusedFunctionParameters` | error | Drop parameters the body never uses |
| `lint/correctness/noUnreachable` | error | Delete code after a return or throw |
| `lint/style/useImportType` | warn | Use `import type { X }` for type-only imports |
| `lint/style/useConsistentArrayType` | warn | Write `T[]`, not `Array<T>` |
| `lint/style/useSelfClosingElements` | error | Close empty JSX elements in place |
| `lint/style/noUselessElse` | error | Drop an `else` after a returning `if` |
| `lint/style/noInferrableTypes` | error | Drop annotations the initializer already implies |
| `lint/a11y/useAltText` | error | Images need alternative text |
| `lint/a11y/useButtonType` | error | Buttons need an explicit `type` |
| `lint/a11y/noSvgWithoutTitle` | error | Inline SVG needs a `<title>` |

This repository turns several recommended rules **off**, so do not reach for them: `noExplicitAny`, `useExhaustiveDependencies`, `noNonNullAssertion`, `useOptionalChain`, and the whole `a11y` recommended set beyond the three listed above.
The override at `biome.json` for `**/*.astro` turns `noUnusedImports` and `noUnusedVariables` off, so frontmatter bindings used only in the template are not flagged.

## IDE integration

Install the official Biome extension (VS Code, JetBrains, Zed). It:

- Shows lint diagnostics inline
- Formats on save using `biome.json`
- Organizes imports on save

Don't run Prettier or ESLint extensions alongside Biome - they'll fight over formatting.

## Pre-commit interaction

On commit, `lint-staged` invokes `biome check --write` against staged files only, which:

1. Formats them
2. Fixes auto-fixable lint issues
3. Re-stages the changes
4. Fails the commit if anything unfixable remains

`lint-staged` also runs `bun run lint:slop` (oxlint) on staged JS, TS and Astro files.
An oxlint failure is not auto-fixable: fix the reported rule or turn it off in `oxlint.config.mts` with a reason comment like the existing entries.

If you see the commit aborted by Biome, run `bun run format:fix` locally, review the diff, and re-commit.

## CI

`.github/workflows/ci.yml` runs `bun run format` (check mode) and then `bun run lint:slop` - any unformatted or lint-failing code blocks the PR. Always run `format:fix` before pushing.

## Gotchas

- Biome respects `.gitignore` by default - don't duplicate entries in `biome.json`
- Biome does not currently parse `.mdx` - only `.ts`, `.tsx`, `.js`, `.jsx`, `.json`
- If Biome and TypeScript disagree on import order after a rebase, run `format:fix` first
- Don't commit a `.prettierrc` / `.eslintrc` - this repo uses only Biome
