import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "@/server/app";
import type { UsageDayReport, UsageReport } from "@/server/usage";
import { hashApiKey } from "@/server/usage";
import { createSqliteD1, type SqliteD1TestDatabase } from "@/test/sqlite-d1";

const databases: SqliteD1TestDatabase[] = [];

const validKey = "test-key";

const fixedNow = new Date("2026-09-10T12:00:00.000Z");

async function fixture(): Promise<SqliteD1TestDatabase> {
  const sqlite = createSqliteD1();
  databases.push(sqlite);
  sqlite.exec(
    "INSERT INTO users (github_login, avatar_url) VALUES ('octocat', 'https://example.com/avatar.png')",
  );
  sqlite.exec(
    `INSERT INTO api_keys (key_hash, user_id) VALUES ('${await hashApiKey(validKey)}', 1)`,
  );
  sqlite.exec(
    `INSERT INTO api_keys (key_hash, user_id, revoked_at) VALUES ('${await hashApiKey("revoked-key")}', 1, '2026-09-01T00:00:00.000Z')`,
  );
  return sqlite;
}

function day(overrides: Partial<UsageDayReport> = {}): UsageDayReport {
  return {
    date: fixedNow.toISOString().slice(0, 10),
    provider: "anthropic",
    model: "claude-opus-5",
    input: 10,
    output: 20,
    cache_create: 5,
    cache_read: 40,
    cost_usd: 0.5,
    ...overrides,
  };
}

function payload(overrides: Partial<UsageReport> = {}): UsageReport {
  return { machine: "mac-1", days: [day()], ...overrides };
}

interface RawJsonValue {
  rawJson: string;
}

interface ConstraintCase {
  field: string;
  scope: "report" | "day";
  accept: unknown[];
  reject: [unknown, string][];
}

const countFields = ["input", "output", "cache_create", "cache_read"] as const;

function rawJson(source: string): RawJsonValue {
  return { rawJson: source };
}

function isRawJson(value: unknown): value is RawJsonValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "rawJson" in value &&
    typeof value.rawJson === "string"
  );
}

function distinctDays(count: number): UsageDayReport[] {
  return Array.from({ length: count }, (_, index) =>
    day({
      date: new Date(Date.UTC(2021, 0, 1 + index)).toISOString().slice(0, 10),
    }),
  );
}

const constraints: ConstraintCase[] = [
  {
    field: "machine",
    scope: "report",
    accept: ["a".repeat(64), "a.b_c-1"],
    reject: [
      ["a".repeat(65), "invalid machine"],
      ["mac 1", "invalid machine"],
      ["", "invalid machine"],
    ],
  },
  {
    field: "days",
    scope: "report",
    accept: [distinctDays(2000)],
    reject: [
      [[], "invalid days"],
      [distinctDays(2001), "invalid days"],
    ],
  },
  {
    field: "timezone",
    scope: "report",
    accept: ["UTC", "Europe/Madrid", "europe/madrid"],
    reject: [
      ["Mars/Olympus", "invalid timezone"],
      ["", "invalid timezone"],
      [42, "invalid timezone"],
    ],
  },
  {
    field: "provider",
    scope: "day",
    accept: ["p".repeat(64)],
    reject: [
      ["p".repeat(65), "invalid provider"],
      ["", "invalid provider"],
    ],
  },
  {
    field: "model",
    scope: "day",
    accept: ["m".repeat(128)],
    reject: [
      ["m".repeat(129), "invalid model"],
      ["", "invalid model"],
    ],
  },
  ...countFields.map<ConstraintCase>((field) => ({
    field,
    scope: "day",
    accept: [0, Number.MAX_SAFE_INTEGER],
    reject: [
      [-1, `invalid ${field}`],
      [1.5, `invalid ${field}`],
      [2 ** 53, `invalid ${field}`],
    ],
  })),
  {
    field: "cost_usd",
    scope: "day",
    accept: [0, 12.5],
    reject: [
      [-1, "invalid cost_usd"],
      [rawJson("1e999"), "invalid cost_usd"],
    ],
  },
  {
    field: "date",
    scope: "day",
    accept: ["2024-02-29"],
    reject: [
      ["2026-02-30", "invalid date"],
      ["2026-13-01", "invalid date"],
      ["20260910", "invalid date"],
    ],
  },
];

const acceptCases = constraints.flatMap((entry) =>
  entry.accept.map((value) => ({ entry, value })),
);

const rejectCases = constraints.flatMap((entry) =>
  entry.reject.map(([value, error]) => ({ entry, value, error })),
);

function constraintDocument(
  entry: ConstraintCase,
  value: unknown,
): Record<string, unknown> {
  return entry.scope === "report"
    ? { ...payload(), [entry.field]: value }
    : { ...payload(), days: [{ ...day(), [entry.field]: value }] };
}

function documentDays(document: Record<string, unknown>): number {
  return Array.isArray(document.days) ? document.days.length : 0;
}

function encode(document: Record<string, unknown>, value: unknown): string {
  const body = JSON.stringify(document);
  return isRawJson(value)
    ? body.replace(JSON.stringify(value), value.rawJson)
    : body;
}

function reportInit(body: string, authorization?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
    },
    body,
  };
}

function todayWindow(range: "day" | "week" | "month") {
  const days = range === "day" ? 1 : range === "week" ? 7 : 30;
  const to = fixedNow.toISOString().slice(0, 10);
  const from = new Date(`${to}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return {
    from: from.toISOString().slice(0, 10),
    to,
    timezone: "UTC",
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: fixedNow, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  for (const sqlite of databases) sqlite.close();
  databases.length = 0;
});

describe("GET /api/health", () => {
  it("reports the service as healthy", async () => {
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("POST /api/report", () => {
  it("rejects a missing, unknown or revoked key without recording anything", async () => {
    const sqlite = await fixture();
    const body = JSON.stringify(payload());
    const responses = await Promise.all([
      app.request("/api/report", reportInit(body), { DB: sqlite.asD1() }),
      app.request("/api/report", reportInit(body, "wrong-key"), {
        DB: sqlite.asD1(),
      }),
      app.request("/api/report", reportInit(body, "revoked-key"), {
        DB: sqlite.asD1(),
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      await expect(response.json()).resolves.toEqual({
        error: "unauthorized",
      });
    }
    expect(sqlite.query("SELECT * FROM usage_days")).toEqual([]);
  });

  it("rejects a body over one mebibyte", async () => {
    const sqlite = await fixture();
    const response = await app.request(
      "/api/report",
      reportInit("x".repeat(1024 * 1024 + 1), validKey),
      { DB: sqlite.asD1() },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "payload too large",
    });
    expect(sqlite.query("SELECT * FROM usage_days")).toEqual([]);
  });

  it("rejects a body that declares more than one mebibyte", async () => {
    const sqlite = await fixture();
    const request = new Request("http://tokenmax.test/api/report", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${validKey}`,
        "Content-Length": "2097152",
      },
      body: JSON.stringify(payload()),
    });
    const response = await app.request(request, undefined, {
      DB: sqlite.asD1(),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "payload too large",
    });
  });

  it("accepts a body of exactly one mebibyte", async () => {
    const sqlite = await fixture();
    const response = await app.request(
      "/api/report",
      reportInit("x".repeat(1024 * 1024), validKey),
      { DB: sqlite.asD1() },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid json" });
  });

  it("accepts a body that declares exactly one mebibyte", async () => {
    const sqlite = await fixture();
    const request = new Request("http://tokenmax.test/api/report", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${validKey}`,
        "Content-Length": "1048576",
      },
      body: JSON.stringify(payload()),
    });
    const response = await app.request(request, undefined, {
      DB: sqlite.asD1(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 1 });
  });

  it("rejects a body that is not a JSON object", async () => {
    const sqlite = await fixture();
    const db = sqlite.asD1();
    const invalid = [
      { body: "not json", error: "invalid json" },
      { body: "[]", error: "invalid report" },
    ];

    for (const { body, error } of invalid) {
      const response = await app.request(
        "/api/report",
        reportInit(body, validKey),
        { DB: db },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error });
    }
    expect(sqlite.query("SELECT * FROM usage_days")).toEqual([]);
  });

  it.each(acceptCases)(
    "accepts $entry.field at a bound the contract allows",
    async ({ entry, value }) => {
      const sqlite = await fixture();
      const document = constraintDocument(entry, value);
      const response = await app.request(
        "/api/report",
        reportInit(encode(document, value), validKey),
        { DB: sqlite.asD1() },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        accepted: documentDays(document),
      });
      expect(sqlite.query("SELECT date FROM usage_days")).toHaveLength(
        documentDays(document),
      );
    },
  );

  it.each(rejectCases)(
    "answers $error for $entry.field outside the contract",
    async ({ entry, value, error }) => {
      const sqlite = await fixture();
      const document = constraintDocument(entry, value);
      const response = await app.request(
        "/api/report",
        reportInit(encode(document, value), validKey),
        { DB: sqlite.asD1() },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error });
      expect(sqlite.query("SELECT * FROM usage_days")).toEqual([]);
    },
  );

  it("defaults a report without a timezone to UTC", async () => {
    const sqlite = await fixture();
    const db = sqlite.asD1();
    const response = await app.request(
      "/api/report",
      reportInit(JSON.stringify(payload()), validKey),
      { DB: db },
    );

    expect(response.status).toBe(200);
    expect(sqlite.query("SELECT timezone FROM machines")).toEqual([
      { timezone: "UTC" },
    ]);
    const summary = await app.request("/api/u/octocat/summary", undefined, {
      DB: db,
    });
    await expect(summary.json()).resolves.toMatchObject({ timezone: "UTC" });
  });

  it("stores the canonical case of a report timezone", async () => {
    const sqlite = await fixture();
    const db = sqlite.asD1();
    const response = await app.request(
      "/api/report",
      reportInit(
        JSON.stringify(payload({ timezone: "europe/madrid" })),
        validKey,
      ),
      { DB: db },
    );

    expect(response.status).toBe(200);
    expect(sqlite.query("SELECT timezone FROM machines")).toEqual([
      { timezone: "Europe/Madrid" },
    ]);
    const summary = await app.request(
      "/api/u/octocat/summary?range=day",
      undefined,
      { DB: db },
    );
    await expect(summary.json()).resolves.toMatchObject({
      timezone: "Europe/Madrid",
      to: "2026-09-10",
    });
  });

  it("records the accepted days", async () => {
    const sqlite = await fixture();
    const response = await app.request(
      "/api/report",
      reportInit(
        JSON.stringify(
          payload({
            days: [day({ date: "2026-09-08" }), day({ date: "2026-09-09" })],
          }),
        ),
        validKey,
      ),
      { DB: sqlite.asD1() },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 2 });
    expect(
      sqlite.query<{ date: string }>(
        "SELECT date FROM usage_days ORDER BY date",
      ),
    ).toEqual([{ date: "2026-09-08" }, { date: "2026-09-09" }]);
    expect(sqlite.query("SELECT last_seen FROM machines")).toEqual([
      { last_seen: fixedNow.toISOString() },
    ]);
  });
});

describe("GET /api/u/:login/summary", () => {
  async function recorded(): Promise<D1Database> {
    const sqlite = await fixture();
    const db = sqlite.asD1();
    const response = await app.request(
      "/api/report",
      reportInit(JSON.stringify(payload()), validKey),
      { DB: db },
    );

    expect(response.status).toBe(200);
    return db;
  }

  it("serves the public summary of every machine with a cache header", async () => {
    const response = await app.request("/api/u/octocat/summary", undefined, {
      DB: await recorded(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=300");
    await expect(response.json()).resolves.toEqual({
      login: "octocat",
      range: "week",
      ...todayWindow("week"),
      totals: {
        input: 10,
        output: 20,
        cache_create: 5,
        cache_read: 40,
        tokens: 75,
        cost_usd: 0.5,
      },
      providers: [
        {
          provider: "anthropic",
          tokens: 75,
          cost_usd: 0.5,
          models: [{ model: "claude-opus-5", tokens: 75, cost_usd: 0.5 }],
        },
      ],
      days: [{ date: day().date, tokens: 75, cost_usd: 0.5 }],
    });
  });

  it("echoes an explicit range", async () => {
    const response = await app.request(
      "/api/u/octocat/summary?range=day",
      undefined,
      { DB: await recorded() },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      range: "day",
      ...todayWindow("day"),
    });
  });

  it("serves the month range through the route", async () => {
    const response = await app.request(
      "/api/u/octocat/summary?range=month",
      undefined,
      { DB: await recorded() },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      range: "month",
      ...todayWindow("month"),
    });
  });

  it("serves a zero summary for a known user with no reports", async () => {
    const response = await app.request("/api/u/octocat/summary", undefined, {
      DB: (await fixture()).asD1(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      login: "octocat",
      range: "week",
      ...todayWindow("week"),
      totals: {
        input: 0,
        output: 0,
        cache_create: 0,
        cache_read: 0,
        tokens: 0,
        cost_usd: 0,
      },
      providers: [],
      days: [],
    });
  });

  it("rejects an unknown range", async () => {
    const response = await app.request(
      "/api/u/octocat/summary?range=year",
      undefined,
      { DB: (await fixture()).asD1() },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid range" });
  });

  it("returns 404 for an unknown user", async () => {
    const response = await app.request("/api/u/nobody/summary", undefined, {
      DB: await recorded(),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "unknown user" });
  });

  it("keeps the default 404 for other paths", async () => {
    const response = await app.request("/api/u/octocat/usage", undefined, {
      DB: (await fixture()).asD1(),
    });

    expect(response.status).toBe(404);
  });
});
