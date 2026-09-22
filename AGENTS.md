# tokenmax - Agent Context

tokenmax is a self-hostable token-usage service: a Cloudflare Worker that stores and serves usage, and a Bun CLI that reports it.

## Structure

```text
tokenmax/
├── apps/worker/         the Astro worker
├── packages/collector/  npm package tokenmax-collector, bin tokenmax
├── scripts/             dependency policy tests
└── .github/             CI and Dependabot automation
```

## Stack

- Bun 1.4.0 workspaces (`apps/*` and `packages/*`), no Turbo.
- TypeScript 6 in strict mode, with Node 24.19.0 declared in `engines.node`.
- Biome 2.5 formats and lints, and oxlint 1.82 with the ultracite anti-slop preset is the second linter.
- Vitest 4.1 runs the workspace specs, and `bun test` runs the dependency policy and workflow golden tests under `scripts/`.
- The collector spawns ccusage 20.0.20, pinned exact because it reads an undocumented JSON shape through a per-platform native binary.
- The collector also decodes the Antigravity CLI conversations under `~/.gemini/antigravity-cli/conversations` itself, because ccusage has no adapter for them: each model step is a protobuf in SQLite, read through `node:sqlite`, priced from the LiteLLM table cached for a day at `~/.config/tokenmax/litellm-prices.json`, and reported as the `antigravity` provider.
- The collector reads the Devin CLI transcripts under `~/.local/share/devin/cli/transcripts` for the same reason: each agent step of an ATIF JSON carries `metrics.prompt_tokens`, `completion_tokens`, `cached_tokens` and `extra.cache_creation_input_tokens`, the uncached input is the prompt minus both caches, the effort suffix of `model_name` collapses into the LiteLLM name (`claude-fable-5-1-xhigh` to `claude-fable-5-1`, `gpt-5-6-sol-high` to `gpt-5.6-sol`), and the rows are reported as the `devin` provider.

## Conventions

- Named exports, and interfaces for object contracts.
- Comments only for a non-obvious why; the code carries the what.
- D1 access lives only under `apps/worker/src/server`.
- Import `env` from `cloudflare:workers` for Cloudflare bindings.
- Conventional commits, enforced by commitlint on the commit message and on the pull request title.

## Scripts

```bash
bun run format                 # biome check . --files-ignore-unknown=true
bun run format:fix             # biome check . --write --files-ignore-unknown=true
bun run lint:slop              # oxlint -c oxlint.config.mts --deny-warnings
bun run check-types            # astro check in apps/worker, tsc --noEmit in packages/collector
bun run test                   # vitest run in every workspace
bun run test:watch
bun run test:dependency-policy # bun test scripts/
bun run test:package           # the packed tarball installs and runs
bun run audit:production
bun run build                  # astro build in apps/worker
```

## Quality gates

- `bun install --frozen-lockfile`, `bun run format`, `bun run lint:slop`, `bun run check-types`, `bun run test`, `bun run test:dependency-policy`, `bun run test:package`, `bun run audit:production` and `bun run build` must pass before a pull request merges.
- The `ci` workflow runs these gates on its configured pull request, `main` push, merge queue and manual dispatch events, and also lints pull request titles.
- On `main`, the `deploy` job ships the worker after the `ci` job succeeds; the collector releases from a tag instead: merge a `chore(collector): release x.y.z` bump, then push `collector-vx.y.z` on that `main` commit and the `release` workflow checks the tag against `packages/collector/package.json`, reruns every gate but `bun run build`, publishes to npm with provenance (skipping a version already there) and creates the GitHub release with generated notes.
- `.husky/pre-commit` runs lint-staged and the workspace type check, and `.husky/commit-msg` runs commitlint.
- A Dependabot patch merges itself only after `gh run watch --exit-status` on the `ci` run for its head commit succeeds, and a patch that touches ccusage always waits for a human.
- Never bypass hooks, and never create Cloudflare resources from repository automation.

## Worker

The worker is `apps/worker`, package `@tokenmax/worker`: Astro 7 with the Cloudflare adapter, a Hono 4 API under `src/server`, one Vue 3 island on `/keys` and D1 for storage.
`bun run build` builds it from the root and `bun run dev` serves it with `astro dev`.
Bindings come from `apps/worker/wrangler.jsonc` and are typed by `bunx wrangler types` into `worker-configuration.d.ts`, which is generated and never hand-edited; the six plain secrets are typed by hand in `src/env.d.ts` and set locally through `apps/worker/.dev.vars`.
The privacy page renders the four `PRIVACY_*` secrets, so every instance carries its own controller identity.
`bunx wrangler d1 migrations apply DB --remote` applies the migrations from `apps/worker`, and `bunx wrangler deploy --dry-run` checks a build without touching Cloudflare.
`GET /api/u/:login/summary?range=day|week|month` is the public contract: `login`, `range`, `from`, `to`, `timezone`, `totals`, `providers` and `days`, served with `Cache-Control: public, s-maxage=300`.
`range` selects a 1-, 7- or 30-day window ending today in the timezone of the user's most recently seen machine, and the collector reports only the last 14 calendar days on each run, so a longer window returns the rows earlier reports left in the store and not a full 30 days of collection.

## Collector

The collector is `packages/collector`, npm name `tokenmax-collector`, bin `tokenmax`, and requires Bun 1.4.0 or newer because `src/cli.ts` runs as TypeScript and reads SQLite through `node:sqlite`.
Install it with `bun add -g tokenmax-collector`, then run `tokenmax install --url <url> --key <key>` with optional `--timezone <zone>`.
Use the global package for scheduling; non-dry `install` rejects Bun's `/install/cache/` and `bunx-<digits>-<package>` paths, while `--dry-run` can still print their plans.
By default it reads `~/.config/tokenmax/config.json`, with `TOKENMAX_HOME` and `XDG_CONFIG_HOME` able to change that location, and sends the report to `POST /api/report` of every target in it.
The config is `{ targets: [{ url, key }], timezone? }`; the single-target `{ url, key, timezone? }` shape written before targets existed still reads.
`install` adds the target for a new url, replaces the key of a url already configured and keeps the rest, then writes that config plus a launchd agent on macOS or a systemd user timer on Linux, and Windows is unsupported.
`collect` reports the last 14 calendar days to `/api/report` and prints one `accepted <n> days for <machine> at <url>` line per target, where `<n>` is the number of usage rows the instance stored and not a count of calendar days; it exits 1 when any target rejects the report.
The machine is identified by its platform uuid on macOS or its `/etc/machine-id` on Linux, and by the hostname, which changes with the network, when the platform identifier cannot be read; the worker also reads that identifier out of the reports an older collector sends with the hostname in front of it.
Upgrade and schedule commands are in `README.md`.

## Keys

Sign in at `/auth/github` to get a key, shown once at `/keys`.
Every sign-in revokes every existing key.
`POST /api/keys/rotate` with the bearer key returns a fresh one.
The schedule runs the installed Bun with `cli.ts collect` every five minutes.
