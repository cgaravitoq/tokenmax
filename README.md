# tokenmax

Self-hostable token-usage service: a Cloudflare Worker that stores daily per-provider and per-model counts reported by a local collector, and serves a public per-login summary.

Extracted from cgaravitoq/portfolio-monorepo at 69ebf6a on 2026-09-12.

## Worker

The worker is `apps/worker`: an Astro 7 app on the Cloudflare adapter with a Hono 4 API, a Vue 3 key page and D1 storage.

### Prerequisites

A Cloudflare account, Bun 1.4.0 and `bunx wrangler login`.

### Deploy

1. Run `git clone https://github.com/cgaravitoq/tokenmax.git`, change into the checkout with `cd tokenmax`, then run `bun install`.
2. From `apps/worker`, run `bunx wrangler d1 create tokenmax`, then replace `d1_databases[0].database_id` in `apps/worker/wrangler.jsonc` with the returned id.
3. Create a GitHub OAuth app whose callback URL is `https://<worker>.workers.dev/auth/github/callback`.
4. Set the six secrets with `bunx wrangler secret put`: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PRIVACY_CONTROLLER`, `PRIVACY_EMAIL`, `PRIVACY_AUTHORITY_NAME` and `PRIVACY_AUTHORITY_URL`.
5. From `apps/worker`, run `bunx wrangler d1 migrations apply DB --remote`.
6. Run `bun run build` from the root, then deploy by pushing to `main` with the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets, or with `bunx wrangler deploy` from `apps/worker`.
7. Sign in at `/auth/github` and copy the key shown once at `/keys`.
8. Install the collector with `bun add -g tokenmax-collector`, run `tokenmax install --url <url> --key <key>`, then run the command printed after `load:` to activate collection on macOS or Linux.

### Local development

Copy `apps/worker/.dev.vars.example` to `apps/worker/.dev.vars` and fill the six values, run `bunx wrangler d1 migrations apply DB --local` from `apps/worker`, create a second GitHub OAuth app whose callback is `http://localhost:8787/auth/github/callback`, then run `bun run build` from the root and `bunx wrangler dev --port 8787` from `apps/worker`.
The callback is derived from the request origin, so no other configuration is needed.

### Public API

`GET /api/u/:login/summary?range=day|week|month` (default `week`) answers `{ login, range, from, to, timezone, totals { input, output, cache_create, cache_read, tokens, cost_usd }, providers [{ provider, tokens, cost_usd, models [{ model, tokens, cost_usd }] }], days [{ date, tokens, cost_usd }] }` with `Cache-Control: public, s-maxage=300`.
Providers and models rank by tokens descending then name, days ascend, and errors are `400 {"error":"invalid range"}` and `404 {"error":"unknown user"}`.

## Collector

The collector requires Bun 1.4.0 or newer, which ships `node:sqlite`, and supports macOS and Linux.
Windows is unsupported.

Install it globally and create the local schedule:

```bash
bun add -g tokenmax-collector
tokenmax install --url <url> --key <key>
```

Pass `--timezone <zone>` to `install` to override the machine's IANA timezone.
Non-dry `tokenmax install` refuses Bun paths containing `/install/cache/` or a `bunx-<digits>-<package>` directory segment because those paths can disappear while a schedule still points to them.
Run `tokenmax collect` to report the last 14 calendar days immediately.
The rows come from ccusage for every agent it detects, plus two sources ccusage has no adapter for, which the collector decodes itself and prices from the LiteLLM table it caches for a day at `~/.config/tokenmax/litellm-prices.json`: the Antigravity CLI conversations under `~/.gemini/antigravity-cli`, reported as `antigravity`, and the Devin CLI transcripts under `~/.local/share/devin/cli/transcripts`, reported as `devin` with the effort suffix of each model collapsed into its LiteLLM name.

The config holds a list of targets, each with its own url and key, and `collect` posts the same report to every one of them.
Running `tokenmax install` with a new url adds a target and keeps the existing ones, and running it again with a configured url replaces that target's key, so one machine can feed a personal instance and a team board at once.

A collector release is a version bump merged to `main` followed by a `collector-v<version>` tag on that commit; the `release` workflow publishes the package to npm with provenance and creates the GitHub release.

To upgrade, reinstall the latest package and regenerate the schedule with the existing key:

```bash
bun add -g tokenmax-collector@latest
tokenmax install --url <url> --key <existing-key>
```

On macOS, run `launchctl bootout gui/<uid>/dev.tokenmax.collector`, then run the printed `launchctl bootstrap` command.
On Linux, run `systemctl --user daemon-reload`, then run the printed `systemctl --user enable --now tokenmax.timer` command.
