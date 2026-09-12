# tokenmax - Agent Context

tokenmax is a self-hostable token-usage service: a Cloudflare Worker that stores and serves usage, and a Bun CLI that reports it.

## Structure

```text
tokenmax/
├── apps/worker/         the Astro worker (lands with P2)
├── packages/collector/  npm package tokenmax-collector, bin tokenmax
├── scripts/             dependency policy tests
└── .github/             CI and Dependabot automation
```

## Stack

- Bun 1.3.14 workspaces (`apps/*` and `packages/*`), no Turbo.
- TypeScript 6 in strict mode, with Node 24.19.0 declared in `engines.node`.
- Biome 2.5 formats and lints, and oxlint 1.82 with the ultracite anti-slop preset is the second linter.
- Vitest 4.1 runs the workspace specs, and `bun test` runs the dependency policy test.
- The collector spawns ccusage 20.0.20, pinned exact because it reads an undocumented JSON shape through a per-platform native binary.
- The worker will be Astro 7 with the Cloudflare adapter, a Hono 4 API, a Vue 3 key page and D1.

## Conventions

- Named exports, and interfaces for object contracts.
- No comments in authored code.
- D1 access lives only under `apps/worker/src/server`.
- Import `env` from `cloudflare:workers` for Cloudflare bindings.
- Conventional commits, enforced by commitlint on the commit message and on the pull request title.

## Scripts

```bash
bun run format                 # biome check .
bun run format:fix             # biome check . --write
bun run lint:slop              # oxlint -c oxlint.config.mts --deny-warnings
bun run check-types            # tsc --noEmit in every workspace
bun run test                   # vitest run in every workspace
bun run test:watch
bun run test:dependency-policy
bun run audit:production
```

## Quality gates

- `bun install --frozen-lockfile`, `bun run format`, `bun run lint:slop`, `bun run check-types`, `bun run test`, `bun run test:dependency-policy` and `bun run audit:production` must pass before a pull request merges.
- The `ci` workflow runs these gates on its configured pull request, `main` push, merge queue and manual dispatch events, and also lints pull request titles.
- `.husky/pre-commit` runs lint-staged and the workspace type check, and `.husky/commit-msg` runs commitlint.
- A Dependabot patch merges itself only after `gh pr checks --watch --fail-fast` reports every check green, and a patch that touches ccusage always waits for a human.
- Never bypass hooks, and never create Cloudflare resources from repository automation.

## Worker

The worker lands with P2.

## Collector

The collector is `packages/collector`, npm name `tokenmax-collector`, and it requires Bun because `src/cli.ts` runs as TypeScript.
By default it reads `~/.config/tokenmax/config.json`, with `TOKENMAX_HOME` and `XDG_CONFIG_HOME` able to change that location, and sends the report to `POST /api/report`.
`install` writes that config plus a launchd agent on macOS or a systemd user timer on Linux, and Windows is unsupported.

## Keys

Sign in at `/auth/github` to get a key, shown once at `/keys`.
Every sign-in revokes every existing key.
`POST /api/keys/rotate` with the bearer key returns a fresh one.
`tokenmax collect` reports the last 14 calendar days to `/api/report`.
The schedule runs the installed Bun with `cli.ts collect` every five minutes.
Installation is `bun add -g tokenmax-collector` (once published, gate 2) then `tokenmax install --url <url> --key <key>`.
