import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { app } from "@/server/app";
import { rotateApiKey, signInRevokeSql } from "@/server/auth";
import { hashApiKey } from "@/server/usage";
import { createSqliteD1, type SqliteD1TestDatabase } from "@/test/sqlite-d1";

const origin = "http://tokenmax.test";
const clientId = "client-id";
const clientSecret = "client-secret";
const githubToken = "github-token";
const avatarUrl = "https://avatars.example/octocat.png";
const validKey = "test-key";
const revokedKey = "revoked-key";

const rotateResponse = z.object({
  key: z.string().regex(/^tmx_[0-9a-f]{64}$/),
});

const reportBody = JSON.stringify({
  machine: "mac-1",
  days: [
    {
      date: "2026-09-10",
      provider: "anthropic",
      model: "claude-opus-5",
      input: 1,
      output: 1,
      cache_create: 0,
      cache_read: 0,
      cost_usd: 0.1,
    },
  ],
});

interface TokenmaxBindings {
  DB: D1Database;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

interface GithubRequest {
  url: string;
  method: string;
  accept: string | null;
  authorization: string | null;
  contentType: string | null;
  userAgent: string | null;
  hasSignal: boolean;
  body: string | null;
}

interface GithubReply {
  status?: number;
  body: string;
}

const databases: SqliteD1TestDatabase[] = [];

function database(): SqliteD1TestDatabase {
  const sqlite = createSqliteD1();
  databases.push(sqlite);
  return sqlite;
}

async function seeded(): Promise<SqliteD1TestDatabase> {
  const sqlite = database();
  sqlite.exec(
    `INSERT INTO users (github_login, avatar_url) VALUES ('octocat', '${avatarUrl}')`,
  );
  sqlite.exec(
    `INSERT INTO api_keys (key_hash, user_id) VALUES ('${await hashApiKey(validKey)}', 1)`,
  );
  sqlite.exec(
    `INSERT INTO api_keys (key_hash, user_id, revoked_at) VALUES ('${await hashApiKey(revokedKey)}', 1, '2026-09-01T00:00:00.000Z')`,
  );
  return sqlite;
}

function environment(db: D1Database): TokenmaxBindings {
  return {
    DB: db,
    GITHUB_CLIENT_ID: clientId,
    GITHUB_CLIENT_SECRET: clientSecret,
  };
}

function stubGithub(replies: GithubReply[]): GithubRequest[] {
  const queue = [...replies];
  const requests: GithubRequest[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const reply = queue.shift();
    if (reply === undefined) {
      throw new Error(`unexpected GitHub request to ${request.url}`);
    }
    requests.push({
      url: request.url,
      method: request.method,
      accept: request.headers.get("Accept"),
      authorization: request.headers.get("Authorization"),
      contentType: request.headers.get("Content-Type"),
      userAgent: request.headers.get("User-Agent"),
      hasSignal: init?.signal !== undefined && init.signal !== null,
      body: typeof init?.body === "string" ? init.body : null,
    });
    return Promise.resolve(
      new Response(reply.body, {
        status: reply.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return requests;
}

function exchangeRequest(code: string): GithubRequest {
  return {
    url: "https://github.com/login/oauth/access_token",
    method: "POST",
    accept: "application/json",
    authorization: null,
    contentType: "application/json",
    userAgent: null,
    hasSignal: true,
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${origin}/auth/github/callback`,
    }),
  };
}

function profileRequest(token: string): GithubRequest {
  return {
    url: "https://api.github.com/user",
    method: "GET",
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    contentType: null,
    userAgent: "tokenmax",
    hasSignal: true,
    body: null,
  };
}

function cookieHeader(response: Response, name: string): string {
  const header = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`));
  if (header === undefined) {
    throw new Error(`missing ${name} cookie`);
  }
  return header;
}

function cookieValue(response: Response, name: string): string {
  const header = cookieHeader(response, name);
  const pair = header.slice(0, header.indexOf(";"));
  return pair.slice(pair.indexOf("=") + 1);
}

function expectCookie(
  response: Response,
  name: string,
  attributes: string[],
): string {
  const header = cookieHeader(response, name);
  expect(header.split("; ").slice(1).sort()).toEqual([...attributes].sort());
  return cookieValue(response, name);
}

function expectStateCleared(response: Response): void {
  expect(
    expectCookie(response, "tokenmax_oauth_state", ["Max-Age=0", "Path=/auth"]),
  ).toBe("");
}

function callbackUrl(state?: string): string {
  const url = new URL(`${origin}/auth/github/callback`);
  url.searchParams.set("code", "the-code");
  if (state !== undefined) {
    url.searchParams.set("state", state);
  }
  return url.toString();
}

function callbackInit(state?: string): RequestInit {
  return state === undefined
    ? {}
    : { headers: { Cookie: `tokenmax_oauth_state=${state}` } };
}

function rotateInit(key?: string): RequestInit {
  return {
    method: "POST",
    ...(key === undefined
      ? {}
      : { headers: { Authorization: `Bearer ${key}` } }),
  };
}

function reportInit(key: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: reportBody,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const sqlite of databases) sqlite.close();
  databases.length = 0;
});

describe("GET /auth/github", () => {
  it("redirects to GitHub with a state cookie and no scope", async () => {
    const response = await app.request(
      `${origin}/auth/github`,
      undefined,
      environment(database().asD1()),
    );

    expect(response.status).toBe(302);
    const authorize = new URL(response.headers.get("Location") ?? "");
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect([...authorize.searchParams.keys()].sort()).toEqual([
      "client_id",
      "redirect_uri",
      "state",
    ]);
    expect(authorize.searchParams.get("client_id")).toBe(clientId);
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${origin}/auth/github/callback`,
    );

    const state = expectCookie(response, "tokenmax_oauth_state", [
      "Max-Age=600",
      "Path=/auth",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
    ]);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(authorize.searchParams.get("state")).toBe(state);
  });

  it("issues a distinct state per authorization", async () => {
    const db = database().asD1();
    const first = await app.request(
      `${origin}/auth/github`,
      undefined,
      environment(db),
    );
    const second = await app.request(
      `${origin}/auth/github`,
      undefined,
      environment(db),
    );

    const firstState = cookieValue(first, "tokenmax_oauth_state");
    const secondState = cookieValue(second, "tokenmax_oauth_state");
    expect(firstState).toMatch(/^[0-9a-f]{64}$/);
    expect(secondState).toMatch(/^[0-9a-f]{64}$/);
    expect(firstState).not.toBe(secondState);
  });
});

describe("GET /auth/github/callback", () => {
  it("rejects a callback without a state cookie", async () => {
    const requests = stubGithub([]);
    const response = await app.request(
      callbackUrl("state-a"),
      callbackInit(),
      environment(database().asD1()),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid state" });
    expectStateCleared(response);
    expect(requests).toEqual([]);
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const requests = stubGithub([]);
    const response = await app.request(
      callbackUrl("state-b"),
      callbackInit("state-a"),
      environment(database().asD1()),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid state" });
    expectStateCleared(response);
    expect(requests).toEqual([]);
  });

  it("rejects a callback without a state parameter", async () => {
    const requests = stubGithub([]);
    const response = await app.request(
      callbackUrl(),
      callbackInit("state-a"),
      environment(database().asD1()),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid state" });
    expectStateCleared(response);
    expect(requests).toEqual([]);
  });

  it("answers 502 when the exchange fails", async () => {
    const requests = stubGithub([{ status: 500, body: "{}" }]);
    const response = await app.request(
      callbackUrl("state-a"),
      callbackInit("state-a"),
      environment(database().asD1()),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "github exchange failed",
    });
    expectStateCleared(response);
    expect(requests).toEqual([exchangeRequest("the-code")]);
  });

  it("answers 502 when the exchange returns no access token", async () => {
    const requests = stubGithub([
      { body: JSON.stringify({ error: "bad_verification_code" }) },
    ]);
    const response = await app.request(
      callbackUrl("state-a"),
      callbackInit("state-a"),
      environment(database().asD1()),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "github exchange failed",
    });
    expectStateCleared(response);
    expect(requests).toEqual([exchangeRequest("the-code")]);
  });

  it("answers 502 when the profile fails", async () => {
    const requests = stubGithub([
      { body: JSON.stringify({ access_token: githubToken }) },
      { status: 401, body: "{}" },
    ]);
    const response = await app.request(
      callbackUrl("state-a"),
      callbackInit("state-a"),
      environment(database().asD1()),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "github profile failed",
    });
    expectStateCleared(response);
    expect(requests).toEqual([
      exchangeRequest("the-code"),
      profileRequest(githubToken),
    ]);
  });

  it("answers 502 when the exchange cannot be reached", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
    const response = await app.request(
      callbackUrl("state-a"),
      callbackInit("state-a"),
      environment(database().asD1()),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "github exchange failed",
    });
    expectStateCleared(response);
  });

  it("answers 502 when the profile cannot be reached", async () => {
    const calls: number[] = [];
    vi.stubGlobal("fetch", () => {
      calls.push(1);
      return calls.length === 1
        ? Promise.resolve(
            new Response(JSON.stringify({ access_token: githubToken }), {
              headers: { "Content-Type": "application/json" },
            }),
          )
        : Promise.reject(new Error("network down"));
    });
    const response = await app.request(
      callbackUrl("state-a"),
      callbackInit("state-a"),
      environment(database().asD1()),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "github profile failed",
    });
    expectStateCleared(response);
  });

  it.each([
    ["without a login", "{}"],
    ["with a non-string login", JSON.stringify({ login: 42 })],
  ])(
    "answers 502 when the profile is 200 %s and writes nothing",
    async (_, body) => {
      const sqlite = database();
      const requests = stubGithub([
        { body: JSON.stringify({ access_token: githubToken }) },
        { body },
      ]);
      const response = await app.request(
        callbackUrl("state-a"),
        callbackInit("state-a"),
        environment(sqlite.asD1()),
      );

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: "github profile failed",
      });
      expectStateCleared(response);
      expect(requests).toEqual([
        exchangeRequest("the-code"),
        profileRequest(githubToken),
      ]);
      expect(sqlite.query("SELECT github_login FROM users")).toEqual([]);
      expect(sqlite.query("SELECT key_hash FROM api_keys")).toEqual([]);
    },
  );

  it("registers the GitHub login and hands out a key once", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const requests = stubGithub([
      { body: JSON.stringify({ access_token: githubToken }) },
      { body: JSON.stringify({ login: "octocat", avatar_url: avatarUrl }) },
    ]);

    const response = await app.request(
      callbackUrl("state-a"),
      callbackInit("state-a"),
      environment(db),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/keys");
    expectStateCleared(response);

    const key = expectCookie(response, "tokenmax_new_key", [
      "Max-Age=60",
      "Path=/keys",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
    ]);
    expect(key).toMatch(/^tmx_[0-9a-f]{64}$/);
    expect(requests).toEqual([
      exchangeRequest("the-code"),
      profileRequest(githubToken),
    ]);
    expect(sqlite.query("SELECT github_login, avatar_url FROM users")).toEqual([
      { github_login: "octocat", avatar_url: avatarUrl },
    ]);
    expect(
      sqlite.query("SELECT key_hash FROM api_keys WHERE revoked_at IS NULL"),
    ).toEqual([{ key_hash: await hashApiKey(key) }]);
  });

  it("stores a GitHub login in lowercase", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    stubGithub([
      { body: JSON.stringify({ access_token: githubToken }) },
      { body: JSON.stringify({ login: "OctoCat", avatar_url: avatarUrl }) },
    ]);

    const response = await app.request(
      callbackUrl("state-a"),
      callbackInit("state-a"),
      environment(db),
    );

    expect(response.status).toBe(303);
    expect(sqlite.query("SELECT github_login FROM users")).toEqual([
      { github_login: "octocat" },
    ]);
  });

  it("writes the user, the revocation and the new key in one batch", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const batch = vi.spyOn(db, "batch");
    const runs = vi.fn();
    sqlite.beforeRun = runs;
    stubGithub([
      { body: JSON.stringify({ access_token: githubToken }) },
      { body: JSON.stringify({ login: "octocat", avatar_url: avatarUrl }) },
    ]);

    const response = await app.request(
      callbackUrl("state-a"),
      callbackInit("state-a"),
      environment(db),
    );

    expect(response.status).toBe(303);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(runs).not.toHaveBeenCalled();
  });

  it("keeps one users row and revokes the first key on a second sign in", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const firstAuthorize = await app.request(
      `${origin}/auth/github`,
      undefined,
      environment(db),
    );
    const secondAuthorize = await app.request(
      `${origin}/auth/github`,
      undefined,
      environment(db),
    );
    const firstState = cookieValue(firstAuthorize, "tokenmax_oauth_state");
    const secondState = cookieValue(secondAuthorize, "tokenmax_oauth_state");
    const requests = stubGithub([
      { body: JSON.stringify({ access_token: githubToken }) },
      { body: JSON.stringify({ login: "octocat", avatar_url: avatarUrl }) },
      { body: JSON.stringify({ access_token: githubToken }) },
      {
        body: JSON.stringify({
          login: "octocat",
          avatar_url: "https://avatars.example/second.png",
        }),
      },
    ]);

    const first = await app.request(
      callbackUrl(firstState),
      callbackInit(firstState),
      environment(db),
    );
    const second = await app.request(
      callbackUrl(secondState),
      callbackInit(secondState),
      environment(db),
    );

    const firstKey = cookieValue(first, "tokenmax_new_key");
    const secondKey = cookieValue(second, "tokenmax_new_key");
    expect(firstKey).toMatch(/^tmx_[0-9a-f]{64}$/);
    expect(secondKey).toMatch(/^tmx_[0-9a-f]{64}$/);
    expect(firstKey).not.toBe(secondKey);
    expect(requests).toEqual([
      exchangeRequest("the-code"),
      profileRequest(githubToken),
      exchangeRequest("the-code"),
      profileRequest(githubToken),
    ]);
    expect(sqlite.query("SELECT github_login, avatar_url FROM users")).toEqual([
      {
        github_login: "octocat",
        avatar_url: "https://avatars.example/second.png",
      },
    ]);
    expect(
      sqlite.query(
        "SELECT revoked_at FROM api_keys WHERE key_hash = ?",
        await hashApiKey(firstKey),
      ),
    ).toEqual([{ revoked_at: expect.any(String) }]);
    expect(
      sqlite.query("SELECT key_hash FROM api_keys WHERE revoked_at IS NULL"),
    ).toEqual([{ key_hash: await hashApiKey(secondKey) }]);
  });
});

describe("POST /api/keys/rotate", () => {
  it("rejects a missing, unknown or revoked key", async () => {
    const sqlite = await seeded();
    const db = sqlite.asD1();
    const responses = await Promise.all([
      app.request(`${origin}/api/keys/rotate`, rotateInit(), environment(db)),
      app.request(
        `${origin}/api/keys/rotate`,
        rotateInit("wrong-key"),
        environment(db),
      ),
      app.request(
        `${origin}/api/keys/rotate`,
        rotateInit(revokedKey),
        environment(db),
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
    expect(
      sqlite.query("SELECT key_hash FROM api_keys WHERE revoked_at IS NULL"),
    ).toEqual([{ key_hash: await hashApiKey(validKey) }]);
  });

  it("leaves exactly one live key after two sequential rotations", async () => {
    const sqlite = await seeded();
    const db = sqlite.asD1();
    await rotateApiKey(db, 1, await hashApiKey("rotated-a"));
    await rotateApiKey(db, 1, await hashApiKey("rotated-b"));

    expect(
      sqlite.query("SELECT key_hash FROM api_keys WHERE revoked_at IS NULL"),
    ).toEqual([{ key_hash: await hashApiKey("rotated-b") }]);
  });

  it("revokes every live key of the user on the route", async () => {
    const sqlite = await seeded();
    const db = sqlite.asD1();
    sqlite.exec(
      `INSERT INTO api_keys (key_hash, user_id) VALUES ('${await hashApiKey("stale-key")}', 1)`,
    );

    const response = await app.request(
      `${origin}/api/keys/rotate`,
      rotateInit(validKey),
      environment(db),
    );

    expect(response.status).toBe(200);
    const rotated = rotateResponse.parse(await response.json());
    expect(
      sqlite.query("SELECT key_hash FROM api_keys WHERE revoked_at IS NULL"),
    ).toEqual([{ key_hash: await hashApiKey(rotated.key) }]);
  });

  it("revokes the presented key and inserts the new one in one batch", async () => {
    const sqlite = await seeded();
    const db = sqlite.asD1();
    const batch = vi.spyOn(db, "batch");
    const runs = vi.fn();
    sqlite.beforeRun = runs;

    const response = await app.request(
      `${origin}/api/keys/rotate`,
      rotateInit(validKey),
      environment(db),
    );

    expect(response.status).toBe(200);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(runs).not.toHaveBeenCalled();
  });

  it("issues a new key, revokes the presented one and keeps it dead", async () => {
    const sqlite = await seeded();
    const db = sqlite.asD1();
    const response = await app.request(
      `${origin}/api/keys/rotate`,
      rotateInit(validKey),
      environment(db),
    );

    expect(response.status).toBe(200);
    const rotated = rotateResponse.parse(await response.json());
    expect(
      sqlite.query("SELECT key_hash FROM api_keys WHERE revoked_at IS NULL"),
    ).toEqual([{ key_hash: await hashApiKey(rotated.key) }]);
    expect(
      sqlite.query(
        "SELECT revoked_at FROM api_keys WHERE key_hash = ?",
        await hashApiKey(validKey),
      ),
    ).toEqual([{ revoked_at: expect.any(String) }]);

    const rejected = await app.request(
      `${origin}/api/report`,
      reportInit(validKey),
      environment(db),
    );
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ error: "unauthorized" });

    const accepted = await app.request(
      `${origin}/api/report`,
      reportInit(rotated.key),
      environment(db),
    );
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ accepted: 1 });
  });
});

describe("the api_keys user_id index", () => {
  it("serves the sign-in revocation", () => {
    const sqlite = database();
    const plan = sqlite.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${signInRevokeSql}`,
      "octocat",
    );

    expect(plan.map(({ detail }) => detail).join("\n")).toContain(
      "api_keys_user_id",
    );
  });
});
