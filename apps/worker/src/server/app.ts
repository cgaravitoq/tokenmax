import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  generateApiKey,
  generateOAuthState,
  registerLogin,
  rotateApiKey,
} from "@/server/auth";
import { parseReport } from "@/server/report";
import type { UsageRange } from "@/server/usage";
import {
  authenticateApiKey,
  hashApiKey,
  recordUsage,
  summarizeUsage,
  usageRanges,
} from "@/server/usage";

const maxReportBytes = 1024 * 1024;

const oauthStateCookie = "tokenmax_oauth_state";
const newKeyCookie = "tokenmax_new_key";

const authorizeEndpoint = "https://github.com/login/oauth/authorize";
const exchangeEndpoint = "https://github.com/login/oauth/access_token";
const profileEndpoint = "https://api.github.com/user";

const githubToken = z.object({ access_token: z.string().min(1) });

const githubProfile = z.object({
  login: z.string().min(1),
  avatar_url: z.string(),
});

const oauthTimeout = 10_000;

export const app = new Hono<{ Bindings: Cloudflare.Env }>();

async function oauthFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(oauthTimeout),
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}

function callbackUrl(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/auth/github/callback`;
}

function bearerKey(header: string | undefined): string | null {
  const prefix = "Bearer ";
  return header?.startsWith(prefix) ? header.slice(prefix.length) : null;
}

function isUsageRange(value: string): value is UsageRange {
  return usageRanges.some((range) => range === value);
}

app.get("/api/health", (context) => context.json({ ok: true }));

app.post("/api/report", async (context) => {
  const key = bearerKey(context.req.header("Authorization"));
  const userId =
    key === null ? null : await authenticateApiKey(context.env.DB, key);
  if (userId === null) {
    return context.json({ error: "unauthorized" }, 401, {
      "WWW-Authenticate": "Bearer",
    });
  }

  const declaredLength = Number(context.req.header("Content-Length") ?? 0);
  if (declaredLength > maxReportBytes) {
    return context.json({ error: "payload too large" }, 413);
  }
  const body = await context.req.arrayBuffer();
  if (body.byteLength > maxReportBytes) {
    return context.json({ error: "payload too large" }, 413);
  }

  const parsed = parseReport(new TextDecoder().decode(body));
  if (!parsed.ok) {
    return context.json({ error: parsed.error }, 400);
  }

  await recordUsage(context.env.DB, userId, parsed.report, new Date());
  return context.json({ accepted: parsed.report.days.length });
});

app.get("/api/u/:login/summary", async (context) => {
  const range = context.req.query("range") ?? "week";
  if (!isUsageRange(range)) {
    return context.json({ error: "invalid range" }, 400);
  }

  const summary = await summarizeUsage(
    context.env.DB,
    context.req.param("login"),
    range,
    new Date(),
  );
  if (summary === null) {
    return context.json({ error: "unknown user" }, 404);
  }

  return context.json(summary, 200, {
    "Cache-Control": "public, s-maxage=300",
  });
});

app.get("/auth/github", (context) => {
  const state = generateOAuthState();
  setCookie(context, oauthStateCookie, state, {
    path: "/auth",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 600,
  });

  const authorize = new URL(authorizeEndpoint);
  authorize.searchParams.set("client_id", context.env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callbackUrl(context.req.url));
  authorize.searchParams.set("state", state);
  return context.redirect(authorize.toString(), 302);
});

app.get("/auth/github/callback", async (context) => {
  const state = context.req.query("state");
  const cookieState = getCookie(context, oauthStateCookie);
  deleteCookie(context, oauthStateCookie, { path: "/auth" });
  if (
    state === undefined ||
    cookieState === undefined ||
    state !== cookieState
  ) {
    return context.json({ error: "invalid state" }, 400);
  }

  const exchange = await oauthFetch(exchangeEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: context.env.GITHUB_CLIENT_ID,
      client_secret: context.env.GITHUB_CLIENT_SECRET,
      code: context.req.query("code") ?? "",
      redirect_uri: callbackUrl(context.req.url),
    }),
  });
  const token = githubToken.safeParse(await exchange.json().catch(() => null));
  if (!exchange.ok || !token.success) {
    return context.json({ error: "github exchange failed" }, 502);
  }

  const profile = await oauthFetch(profileEndpoint, {
    headers: {
      Authorization: `Bearer ${token.data.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tokenmax",
    },
  });
  const user = githubProfile.safeParse(await profile.json().catch(() => null));
  if (!profile.ok || !user.success) {
    return context.json({ error: "github profile failed" }, 502);
  }

  const key = generateApiKey();
  await registerLogin(
    context.env.DB,
    user.data.login,
    user.data.avatar_url,
    await hashApiKey(key),
  );
  setCookie(context, newKeyCookie, key, {
    path: "/keys",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 60,
  });
  return context.redirect("/keys", 303);
});

app.post("/api/keys/rotate", async (context) => {
  const key = bearerKey(context.req.header("Authorization"));
  if (key === null) {
    return context.json({ error: "unauthorized" }, 401, {
      "WWW-Authenticate": "Bearer",
    });
  }

  const userId = await authenticateApiKey(context.env.DB, key);
  if (userId === null) {
    return context.json({ error: "unauthorized" }, 401, {
      "WWW-Authenticate": "Bearer",
    });
  }

  const newKey = generateApiKey();
  await rotateApiKey(context.env.DB, userId, await hashApiKey(newKey));
  return context.json({ key: newKey });
});
