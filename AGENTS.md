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
- Vitest 4.1 runs the workspace specs, and `bun test` runs the dependency policy and workflow golden tests under `scripts/`.
- The collector spawns ccusage 20.0.20, pinned exact because it reads an undocumented JSON shape through a per-platform native binary.
- The collector also decodes the Antigravity CLI conversations under `~/.gemini/antigravity-cli/conversations` itself, because ccusage has no adapter for them: each model step is a protobuf in SQLite, read through `node:sqlite`, priced from the LiteLLM table cached for a day at `~/.config/tokenmax/litellm-prices.json`, and reported as the `antigravity` provider.
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
- On `main`, the `deploy` job ships the worker on every push; the collector releases from a tag instead: merge a `chore(collector): release x.y.z` bump, then push `collector-vx.y.z` on that `main` commit and the `release` workflow checks the tag against `packages/collector/package.json`, reruns the gates, publishes to npm with provenance (skipping a version already there) and creates the GitHub release with generated notes.
- `.husky/pre-commit` runs lint-staged and the workspace type check, and `.husky/commit-msg` runs commitlint.
- A Dependabot patch merges itself only after `gh pr checks --watch --fail-fast` reports every check green, and a patch that touches ccusage always waits for a human.
- Never bypass hooks, and never create Cloudflare resources from repository automation.

## Worker

The worker is `apps/worker`, package `@tokenmax/worker`: Astro 7 with the Cloudflare adapter, a Hono 4 API under `src/server`, one Vue 3 island on `/keys` and D1 for storage.
`bun run build` builds it from the root and `bun run dev` serves it with `astro dev`.
Bindings come from `apps/worker/wrangler.jsonc` and are typed by `bunx wrangler types` into `worker-configuration.d.ts`, which is generated and never hand-edited; the six plain secrets are typed by hand in `src/env.d.ts` and set locally through `apps/worker/.dev.vars`.
The privacy page renders the four `PRIVACY_*` secrets, so every instance carries its own controller identity.
`bunx wrangler d1 migrations apply DB --remote` applies the migrations from `apps/worker`, and `bunx wrangler deploy --dry-run` checks a build without touching Cloudflare.
`GET /api/u/:login/summary?range=day|week|month` is the public contract: `login`, `range`, `from`, `to`, `timezone`, `totals`, `providers` and `days`, served with `Cache-Control: public, s-maxage=300`.

## Collector

The collector is `packages/collector`, npm name `tokenmax-collector`, bin `tokenmax`, and requires Bun 1.3.14 or newer because `src/cli.ts` runs as TypeScript.
Install it with `bun add -g tokenmax-collector`, then run `tokenmax install --url <url> --key <key>` with optional `--timezone <zone>`.
Use the global package for scheduling; non-dry `install` rejects Bun's `/install/cache/` and `bunx-<digits>-<package>` paths, while `--dry-run` can still print their plans.
By default it reads `~/.config/tokenmax/config.json`, with `TOKENMAX_HOME` and `XDG_CONFIG_HOME` able to change that location, and sends the report to `POST /api/report`.
`install` writes that config plus a launchd agent on macOS or a systemd user timer on Linux, and Windows is unsupported.
Upgrade with `bun add -g tokenmax-collector@latest`, then run `tokenmax install --url <url> --key <existing-key>` again.
On macOS, run `launchctl bootout gui/<uid>/dev.tokenmax.collector`, then run the printed `launchctl bootstrap` command.
On Linux, run `systemctl --user daemon-reload`, then run the printed `systemctl --user enable --now tokenmax.timer` command.
`tokenmax collect` reports the last 14 calendar days to `/api/report`.

## Keys

Sign in at `/auth/github` to get a key, shown once at `/keys`.
Every sign-in revokes every existing key.
`POST /api/keys/rotate` with the bearer key returns a fresh one.
`tokenmax collect` reports the last 14 calendar days to `/api/report`.
The schedule runs the installed Bun with `cli.ts collect` every five minutes.
Installation is `bun add -g tokenmax-collector` then `tokenmax install --url <url> --key <key>`.
