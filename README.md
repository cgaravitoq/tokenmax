# tokenmax

Self-hostable token-usage service: a Cloudflare Worker that stores daily per-provider and per-model counts reported by a local collector, and serves a public per-login summary.

Extracted from cgaravitoq/portfolio-monorepo at 69ebf6a on 2026-09-12.

## Worker

The worker is `apps/worker`: an Astro 7 app on the Cloudflare adapter with a Hono 4 API, a Vue 3 key page and D1 storage.

### Prerequisites

A Cloudflare account, Bun 1.3.14 and `bunx wrangler login`.

### Deploy

1. `git clone` the repository and run `bun install` from the root.
2. From `apps/worker`, run `bunx wrangler d1 create tokenmax`, then paste the returned `database_id` into `d1_databases[0]` in `apps/worker/wrangler.jsonc`.
3. Create a GitHub OAuth app whose callback URL is `https://<worker>.workers.dev/auth/github/callback`.
4. Set the six secrets with `bunx wrangler secret put`: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PRIVACY_CONTROLLER`, `PRIVACY_EMAIL`, `PRIVACY_AUTHORITY_NAME` and `PRIVACY_AUTHORITY_URL`.
5. From `apps/worker`, run `bunx wrangler d1 migrations apply DB --remote`.
6. Run `bun run build` from the root, then deploy by pushing to `main` with the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets, or with `bunx wrangler deploy` from `apps/worker`.
7. Sign in at `/auth/github` and copy the key shown once at `/keys`.
8. Install the collector with `bun add -g tokenmax-collector` (once published) and schedule it with `tokenmax install --url <url> --key <key>`.

### Local development

Copy `apps/worker/.dev.vars.example` to `apps/worker/.dev.vars` and fill the six values, run `bunx wrangler d1 migrations apply DB --local` from `apps/worker`, create a second GitHub OAuth app whose callback is `http://localhost:8787/auth/github/callback`, then run `bun run build` from the root and `bunx wrangler dev --port 8787` from `apps/worker`.
The callback is derived from the request origin, so no other configuration is needed.

### Public API

`GET /api/u/:login/summary?range=day|week|month` (default `week`) answers `{ login, range, from, to, timezone, totals { input, output, cache_create, cache_read, tokens, cost_usd }, providers [{ provider, tokens, cost_usd, models [{ model, tokens, cost_usd }] }], days [{ date, tokens, cost_usd }] }` with `Cache-Control: public, s-maxage=300`.
Providers and models rank by tokens descending then name, days ascend, and errors are `400 {"error":"invalid range"}` and `404 {"error":"unknown user"}`.

## Collector

The installation guide lands with the publishable collector.
