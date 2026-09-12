---
name: astro-patterns
description: Astro 7 and Cloudflare Workers patterns for the tokenmax worker pages, endpoints, bindings and specs.
---

# Astro Patterns

`apps/worker` is an Astro 7 SSR Worker with the Cloudflare adapter, a Hono API and D1 storage.

## Pages and endpoints

- Routes live in `src/pages/` and the Vue island in `src/components/`.
- `src/pages/api/[...path].ts` and `src/pages/auth/[...path].ts` are the two catch-alls; they pass the request and `env` from `cloudflare:workers` to the Hono app in `src/server/app.ts`.
- Keep domain and persistence logic in `src/server/` and import it through `@/`.
- Use `APIRoute` for HTTP endpoints and return explicit `Response` objects.
- A page that reads bindings declares `export const prerender = false`.

## Bindings

D1 comes from `apps/worker/wrangler.jsonc` and is typed by `bunx wrangler types` into `worker-configuration.d.ts`, which is generated and never hand-edited.
Secrets are typed by hand in `src/env.d.ts` and set through `bunx wrangler secret put` or `.dev.vars`.

## Specs

Specs run under Vitest with the Vue integration, and the `cloudflare:workers` alias points at `src/test/cloudflare-workers.ts` for the mutable `env`.
`src/test/sqlite-d1.ts` fakes D1 with `node:sqlite`, and `src/test/wrangler-config.spec.ts` asserts the shape of `wrangler.jsonc`.
