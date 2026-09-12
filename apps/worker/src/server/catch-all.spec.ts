import { env } from "cloudflare:workers";
import type { APIContext } from "astro";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1, type SqliteD1TestDatabase } from "@/test/sqlite-d1";
import { ALL as apiRoute } from "../pages/api/[...path]";
import { ALL as authRoute } from "../pages/auth/[...path]";
import { app } from "./app";

type Route = typeof apiRoute;

const databases: SqliteD1TestDatabase[] = [];

function context(url: string, method: string): APIContext {
  const context: Pick<APIContext, "request"> = {
    request: new Request(url, { method }),
  };
  return context as APIContext;
}

async function forward(route: Route, url: string, method: string) {
  const fetchSpy = vi.spyOn(app, "fetch");
  const routeContext = context(url, method);
  const response = await route(routeContext);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy.mock.calls[0][0]).toBe(routeContext.request);
  expect(response).toBe(await fetchSpy.mock.results[0].value);

  return response;
}

describe("catch-all routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const sqlite of databases) sqlite.close();
    databases.length = 0;
  });

  for (const method of ["GET", "POST"]) {
    it(`forwards ${method} /api requests to the Hono app`, async () => {
      await forward(apiRoute, "http://tokenmax.test/api/health", method);
    });

    it(`forwards ${method} /auth requests to the Hono app`, async () => {
      await forward(authRoute, "http://tokenmax.test/auth/anything", method);
    });
  }

  it("answers GET /api/health from the Hono app", async () => {
    const response = await apiRoute(
      context("http://tokenmax.test/api/health", "GET"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("hands the worker environment to the Hono app", async () => {
    const sqlite = createSqliteD1();
    databases.push(sqlite);
    sqlite.exec(
      "INSERT INTO users (github_login, avatar_url) VALUES ('octocat', 'https://example.com/avatar.png')",
    );
    Object.assign(env, { DB: sqlite.asD1() });

    const response = await apiRoute(
      context("http://tokenmax.test/api/u/octocat/summary", "GET"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ login: "octocat" });
  });
});
