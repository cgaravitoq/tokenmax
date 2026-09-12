import { afterEach, describe, expect, it } from "vitest";
import type { UsageDayReport, UsageRange, UsageReport } from "@/server/usage";
import {
  authenticateApiKey,
  hashApiKey,
  recordUsage,
  summarizeUsage,
} from "@/server/usage";
import { createSqliteD1, SqliteD1TestDatabase } from "@/test/sqlite-d1";

interface StoredUsage {
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  cost_usd: number;
  machine_id: string;
}

const databases: SqliteD1TestDatabase[] = [];

function database(): SqliteD1TestDatabase {
  const sqlite = createSqliteD1();
  databases.push(sqlite);
  return sqlite;
}

function seedUser(sqlite: SqliteD1TestDatabase, login = "octocat"): number {
  sqlite.exec(
    `INSERT INTO users (github_login, avatar_url) VALUES ('${login}', 'https://example.com/avatar.png')`,
  );
  return sqlite.query<{ id: number }>(
    "SELECT id FROM users WHERE github_login = ?",
    login,
  )[0].id;
}

function storedUsage(sqlite: SqliteD1TestDatabase): StoredUsage[] {
  return sqlite.query<StoredUsage>(
    "SELECT machine_id, input, output, cache_create, cache_read, cost_usd FROM usage_days ORDER BY machine_id",
  );
}

function day(overrides: Partial<UsageDayReport> = {}): UsageDayReport {
  return {
    date: "2026-09-10",
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

function report(
  machine: string,
  days: UsageDayReport[],
  timezone?: string,
): UsageReport {
  return { machine, days, timezone };
}

function tokensDay(date: string, tokens: number): UsageDayReport {
  return {
    date,
    provider: "anthropic",
    model: "claude-opus-5",
    input: tokens,
    output: 0,
    cache_create: 0,
    cache_read: 0,
    cost_usd: tokens,
  };
}

const now = new Date("2026-09-10T23:59:59.000Z");

const reportedAt = new Date("2026-09-10T08:00:00.000Z");

afterEach(() => {
  for (const sqlite of databases) sqlite.close();
  databases.length = 0;
});

describe("hashApiKey", () => {
  it("returns the lowercase hex SHA-256 of the key", async () => {
    await expect(hashApiKey("test-key")).resolves.toBe(
      "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef",
    );
  });
});

describe("authenticateApiKey", () => {
  it("resolves the user of a live key and rejects unknown or revoked keys", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);
    sqlite.exec(
      `INSERT INTO api_keys (key_hash, user_id) VALUES ('${await hashApiKey("test-key")}', ${userId})`,
    );
    sqlite.exec(
      `INSERT INTO api_keys (key_hash, user_id, revoked_at) VALUES ('${await hashApiKey("revoked-key")}', ${userId}, '2026-09-01T00:00:00.000Z')`,
    );

    await expect(authenticateApiKey(db, "test-key")).resolves.toBe(userId);
    await expect(authenticateApiKey(db, "wrong-key")).resolves.toBeNull();
    await expect(authenticateApiKey(db, "revoked-key")).resolves.toBeNull();
  });
});

describe("recordUsage", () => {
  it("keeps the stored numbers when a report repeats lower ones", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);

    await recordUsage(db, userId, report("mac-1", [day()]), reportedAt);
    await recordUsage(
      db,
      userId,
      report("mac-1", [
        day({
          input: 3,
          output: 4,
          cache_create: 1,
          cache_read: 2,
          cost_usd: 0.1,
        }),
      ]),
      reportedAt,
    );

    expect(storedUsage(sqlite)).toEqual([
      {
        machine_id: "mac-1",
        input: 10,
        output: 20,
        cache_create: 5,
        cache_read: 40,
        cost_usd: 0.5,
      },
    ]);
  });

  it("raises each stored number independently", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);

    await recordUsage(db, userId, report("mac-1", [day()]), reportedAt);
    await recordUsage(
      db,
      userId,
      report("mac-1", [day({ input: 30, output: 5, cost_usd: 0.9 })]),
      reportedAt,
    );

    expect(storedUsage(sqlite)).toEqual([
      {
        machine_id: "mac-1",
        input: 30,
        output: 20,
        cache_create: 5,
        cache_read: 40,
        cost_usd: 0.9,
      },
    ]);
  });

  it("adds the numbers of another machine", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);

    await recordUsage(db, userId, report("mac-1", [day()]), reportedAt);
    await recordUsage(db, userId, report("mac-2", [day()]), reportedAt);

    expect(storedUsage(sqlite)).toEqual([
      {
        machine_id: "mac-1",
        input: 10,
        output: 20,
        cache_create: 5,
        cache_read: 40,
        cost_usd: 0.5,
      },
      {
        machine_id: "mac-2",
        input: 10,
        output: 20,
        cache_create: 5,
        cache_read: 40,
        cost_usd: 0.5,
      },
    ]);
  });

  it("writes nothing when one day of the report fails", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);

    await expect(
      recordUsage(
        db,
        userId,
        report("mac-1", [
          day(),
          day({ date: "2026-09-11", cost_usd: Number.NaN }),
        ]),
        reportedAt,
      ),
    ).rejects.toThrow();

    expect(sqlite.query("SELECT * FROM machines")).toEqual([]);
    expect(sqlite.query("SELECT * FROM usage_days")).toEqual([]);
  });

  it("refreshes the machine last-seen stamp without duplicating it", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);

    const laterAt = new Date("2026-09-11T09:30:00.000Z");

    await recordUsage(db, userId, report("mac-1", [day()]), reportedAt);
    await recordUsage(
      db,
      userId,
      report("mac-1", [day({ date: "2026-09-11" })]),
      laterAt,
    );

    const machines = sqlite.query<{ machine_id: string; last_seen: string }>(
      "SELECT machine_id, last_seen FROM machines",
    );

    expect(machines).toEqual([
      { machine_id: "mac-1", last_seen: laterAt.toISOString() },
    ]);
  });

  it("replaces a machine's buckets when its timezone changes", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);

    await recordUsage(
      db,
      userId,
      report("mac-1", [tokensDay("2026-09-10", 100)], "UTC"),
      reportedAt,
    );
    await recordUsage(
      db,
      userId,
      report("mac-1", [tokensDay("2026-09-10", 60)], "Europe/Madrid"),
      new Date("2026-09-10T20:00:00.000Z"),
    );

    const switched = await summarizeUsage(
      db,
      "octocat",
      "day",
      new Date("2026-09-10T12:00:00.000Z"),
    );
    expect(switched?.timezone).toBe("Europe/Madrid");
    expect(switched?.totals.input).toBe(60);

    await recordUsage(
      db,
      userId,
      report("mac-1", [tokensDay("2026-09-10", 50)], "Europe/Madrid"),
      new Date("2026-09-10T21:00:00.000Z"),
    );

    const repeated = await summarizeUsage(
      db,
      "octocat",
      "day",
      new Date("2026-09-10T12:00:00.000Z"),
    );
    expect(repeated?.totals.input).toBe(60);
  });

  it("replaces from the earliest reported date and only for that machine", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);

    await recordUsage(
      db,
      userId,
      report(
        "mac-1",
        [tokensDay("2026-09-01", 5), tokensDay("2026-09-10", 100)],
        "UTC",
      ),
      reportedAt,
    );
    await recordUsage(
      db,
      userId,
      report("mac-2", [tokensDay("2026-09-10", 7)], "UTC"),
      reportedAt,
    );
    await recordUsage(
      db,
      userId,
      report(
        "mac-1",
        [tokensDay("2026-09-11", 70), tokensDay("2026-09-10", 60)],
        "Europe/Madrid",
      ),
      new Date("2026-09-11T08:00:00.000Z"),
    );

    expect(
      sqlite.query<{ machine_id: string; date: string; input: number }>(
        "SELECT machine_id, date, input FROM usage_days ORDER BY machine_id, date",
      ),
    ).toEqual([
      { machine_id: "mac-1", date: "2026-09-01", input: 5 },
      { machine_id: "mac-1", date: "2026-09-10", input: 60 },
      { machine_id: "mac-1", date: "2026-09-11", input: 70 },
      { machine_id: "mac-2", date: "2026-09-10", input: 7 },
    ]);
  });
});

describe("summarizeUsage", () => {
  async function edgeDays(): Promise<D1Database> {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);

    await recordUsage(
      db,
      userId,
      report("mac-1", [
        tokensDay("2026-08-11", 1),
        tokensDay("2026-08-12", 2),
        tokensDay("2026-09-03", 3),
        tokensDay("2026-09-04", 4),
        tokensDay("2026-09-10", 5),
        tokensDay("2026-09-11", 6),
      ]),
      reportedAt,
    );
    return db;
  }

  it("windows the day range on the UTC date of now", async () => {
    const summary = await summarizeUsage(
      await edgeDays(),
      "octocat",
      "day",
      now,
    );

    expect(summary?.from).toBe("2026-09-10");
    expect(summary?.to).toBe("2026-09-10");
    expect(summary?.days).toEqual([
      { date: "2026-09-10", tokens: 5, cost_usd: 5 },
    ]);
    expect(summary?.totals.tokens).toBe(5);
  });

  it("windows the week range as the seven days ending today", async () => {
    const summary = await summarizeUsage(
      await edgeDays(),
      "octocat",
      "week",
      now,
    );

    expect(summary?.from).toBe("2026-09-04");
    expect(summary?.to).toBe("2026-09-10");
    expect(summary?.days).toEqual([
      { date: "2026-09-04", tokens: 4, cost_usd: 4 },
      { date: "2026-09-10", tokens: 5, cost_usd: 5 },
    ]);
    expect(summary?.totals.tokens).toBe(9);
  });

  it("windows the month range as the thirty days ending today", async () => {
    const summary = await summarizeUsage(
      await edgeDays(),
      "octocat",
      "month",
      now,
    );

    expect(summary?.from).toBe("2026-08-12");
    expect(summary?.to).toBe("2026-09-10");
    expect(summary?.days).toEqual([
      { date: "2026-08-12", tokens: 2, cost_usd: 2 },
      { date: "2026-09-03", tokens: 3, cost_usd: 3 },
      { date: "2026-09-04", tokens: 4, cost_usd: 4 },
      { date: "2026-09-10", tokens: 5, cost_usd: 5 },
    ]);
    expect(summary?.totals.tokens).toBe(14);
  });

  it("moves the window when the UTC date changes", async () => {
    const summary = await summarizeUsage(
      await edgeDays(),
      "octocat",
      "day",
      new Date("2026-09-11T00:00:00.000Z"),
    );

    expect(summary?.from).toBe("2026-09-11");
    expect(summary?.to).toBe("2026-09-11");
    expect(summary?.days).toEqual([
      { date: "2026-09-11", tokens: 6, cost_usd: 6 },
    ]);
  });

  it("groups providers and models across machines, ranked by tokens", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);

    await recordUsage(
      db,
      userId,
      report("mac-1", [
        day({
          date: "2026-09-10",
          model: "claude-sonnet-5",
          input: 30,
          output: 0,
          cache_create: 0,
          cache_read: 0,
          cost_usd: 3,
        }),
        day({
          date: "2026-09-10",
          model: "claude-opus-5",
          input: 10,
          output: 0,
          cache_create: 0,
          cache_read: 0,
          cost_usd: 1,
        }),
        day({
          date: "2026-09-09",
          provider: "openai",
          model: "gpt-5",
          input: 10,
          output: 0,
          cache_create: 0,
          cache_read: 0,
          cost_usd: 1,
        }),
      ]),
      reportedAt,
    );
    await recordUsage(
      db,
      userId,
      report("mac-2", [
        day({
          date: "2026-09-10",
          provider: "openai",
          model: "gpt-5",
          input: 30,
          output: 0,
          cache_create: 0,
          cache_read: 0,
          cost_usd: 3,
        }),
        day({
          date: "2026-09-10",
          provider: "google",
          model: "gemini-5",
          input: 5,
          output: 0,
          cache_create: 0,
          cache_read: 0,
          cost_usd: 0.5,
        }),
      ]),
      reportedAt,
    );

    const summary = await summarizeUsage(db, "octocat", "week", now);

    expect(summary?.providers).toEqual([
      {
        provider: "anthropic",
        tokens: 40,
        cost_usd: 4,
        models: [
          { model: "claude-sonnet-5", tokens: 30, cost_usd: 3 },
          { model: "claude-opus-5", tokens: 10, cost_usd: 1 },
        ],
      },
      {
        provider: "openai",
        tokens: 40,
        cost_usd: 4,
        models: [{ model: "gpt-5", tokens: 40, cost_usd: 4 }],
      },
      {
        provider: "google",
        tokens: 5,
        cost_usd: 0.5,
        models: [{ model: "gemini-5", tokens: 5, cost_usd: 0.5 }],
      },
    ]);
    expect(summary?.days.map(({ date }) => date)).toEqual([
      "2026-09-09",
      "2026-09-10",
    ]);
    expect(summary?.totals).toEqual({
      input: 85,
      output: 0,
      cache_create: 0,
      cache_read: 0,
      tokens: 85,
      cost_usd: 8.5,
    });
  });

  it("ranks providers and models by tokens, not by cost", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);

    await recordUsage(
      db,
      userId,
      report("mac-1", [
        day({
          date: "2026-09-10",
          provider: "anthropic",
          model: "claude-opus-5",
          input: 70,
          output: 0,
          cache_create: 0,
          cache_read: 0,
          cost_usd: 1,
        }),
        day({
          date: "2026-09-10",
          provider: "anthropic",
          model: "claude-sonnet-5",
          input: 30,
          output: 0,
          cache_create: 0,
          cache_read: 0,
          cost_usd: 9,
        }),
        day({
          date: "2026-09-10",
          provider: "openai",
          model: "gpt-5",
          input: 50,
          output: 0,
          cache_create: 0,
          cache_read: 0,
          cost_usd: 40,
        }),
      ]),
      reportedAt,
    );

    const summary = await summarizeUsage(db, "octocat", "week", now);

    expect(summary?.providers.map(({ provider }) => provider)).toEqual([
      "anthropic",
      "openai",
    ]);
    expect(summary?.providers[0].models.map(({ model }) => model)).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
  });

  it("never exposes machine identifiers", async () => {
    const summary = await summarizeUsage(
      await edgeDays(),
      "octocat",
      "month",
      now,
    );

    expect(JSON.stringify(summary)).not.toContain("machine");
  });

  it("summarizes a known user with no rows in the window as zero", async () => {
    const summary = await summarizeUsage(
      await edgeDays(),
      "octocat",
      "day",
      new Date("2026-09-20T12:00:00.000Z"),
    );

    expect(summary).toEqual({
      login: "octocat",
      range: "day",
      from: "2026-09-20",
      to: "2026-09-20",
      timezone: "UTC",
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

  it("returns null for an unknown login", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    seedUser(sqlite);

    await expect(summarizeUsage(db, "nobody", "week", now)).resolves.toBeNull();
  });

  async function zonedDays(timezone: string, at: Date): Promise<D1Database> {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);

    await recordUsage(
      db,
      userId,
      report(
        "mac-1",
        [
          tokensDay("2026-08-12", 2),
          tokensDay("2026-08-13", 3),
          tokensDay("2026-09-04", 4),
          tokensDay("2026-09-05", 5),
          tokensDay("2026-09-10", 6),
          tokensDay("2026-09-11", 7),
        ],
        timezone,
      ),
      at,
    );
    return db;
  }

  async function windows(db: D1Database, at: Date, range: UsageRange) {
    const summary = await summarizeUsage(db, "octocat", range, at);
    return {
      timezone: summary?.timezone,
      from: summary?.from,
      to: summary?.to,
      days: summary?.days.map(({ date }) => date),
    };
  }

  it("windows the calendar dates in the machine timezone", async () => {
    const at = new Date("2026-09-10T22:30:00.000Z");

    await expect(
      windows(await zonedDays("Europe/Madrid", at), at, "day"),
    ).resolves.toEqual({
      timezone: "Europe/Madrid",
      from: "2026-09-11",
      to: "2026-09-11",
      days: ["2026-09-11"],
    });
    await expect(
      windows(await zonedDays("Europe/Madrid", at), at, "week"),
    ).resolves.toEqual({
      timezone: "Europe/Madrid",
      from: "2026-09-05",
      to: "2026-09-11",
      days: ["2026-09-05", "2026-09-10", "2026-09-11"],
    });
    await expect(
      windows(await zonedDays("Europe/Madrid", at), at, "month"),
    ).resolves.toEqual({
      timezone: "Europe/Madrid",
      from: "2026-08-13",
      to: "2026-09-11",
      days: [
        "2026-08-13",
        "2026-09-04",
        "2026-09-05",
        "2026-09-10",
        "2026-09-11",
      ],
    });
    await expect(
      windows(await zonedDays("UTC", at), at, "day"),
    ).resolves.toEqual({
      timezone: "UTC",
      from: "2026-09-10",
      to: "2026-09-10",
      days: ["2026-09-10"],
    });
    await expect(
      windows(await zonedDays("UTC", at), at, "week"),
    ).resolves.toEqual({
      timezone: "UTC",
      from: "2026-09-04",
      to: "2026-09-10",
      days: ["2026-09-04", "2026-09-05", "2026-09-10"],
    });
    await expect(
      windows(await zonedDays("UTC", at), at, "month"),
    ).resolves.toEqual({
      timezone: "UTC",
      from: "2026-08-12",
      to: "2026-09-10",
      days: [
        "2026-08-12",
        "2026-08-13",
        "2026-09-04",
        "2026-09-05",
        "2026-09-10",
      ],
    });
  });

  it("windows the day before the UTC date in a western timezone", async () => {
    const at = new Date("2026-09-11T00:30:00.000Z");

    await expect(
      windows(await zonedDays("America/Los_Angeles", at), at, "day"),
    ).resolves.toEqual({
      timezone: "America/Los_Angeles",
      from: "2026-09-10",
      to: "2026-09-10",
      days: ["2026-09-10"],
    });
  });

  it("takes the timezone of the most recently seen machine", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);

    await recordUsage(
      db,
      userId,
      report("mac-1", [tokensDay("2026-09-10", 1)], "Europe/Madrid"),
      new Date("2026-09-10T08:00:00.000Z"),
    );
    await recordUsage(
      db,
      userId,
      report("mac-2", [tokensDay("2026-09-10", 2)], "America/Los_Angeles"),
      new Date("2026-09-10T09:00:00.000Z"),
    );

    await expect(
      summarizeUsage(db, "octocat", "day", now),
    ).resolves.toMatchObject({
      timezone: "America/Los_Angeles",
      from: "2026-09-10",
      to: "2026-09-10",
    });
  });

  it("takes the timezone of the user's own machines only", async () => {
    const sqlite = database();
    const db = sqlite.asD1();
    const userId = seedUser(sqlite);
    const otherId = seedUser(sqlite, "other");

    await recordUsage(
      db,
      userId,
      report("mac-1", [tokensDay("2026-09-10", 1)], "Europe/Madrid"),
      new Date("2026-09-10T08:00:00.000Z"),
    );
    await recordUsage(
      db,
      otherId,
      report("mac-2", [tokensDay("2026-09-10", 2)], "America/Los_Angeles"),
      new Date("2026-09-10T09:00:00.000Z"),
    );

    await expect(
      summarizeUsage(db, "octocat", "day", now),
    ).resolves.toMatchObject({ timezone: "Europe/Madrid", to: "2026-09-11" });
    await expect(
      summarizeUsage(db, "other", "day", now),
    ).resolves.toMatchObject({
      timezone: "America/Los_Angeles",
      to: "2026-09-10",
    });
  });

  it("falls back to UTC when the user has no machine", async () => {
    const sqlite = database();
    seedUser(sqlite);

    await expect(
      summarizeUsage(
        sqlite.asD1(),
        "octocat",
        "day",
        new Date("2026-09-11T00:30:00.000Z"),
      ),
    ).resolves.toMatchObject({
      timezone: "UTC",
      from: "2026-09-11",
      to: "2026-09-11",
    });
  });

  it("reads a machine stored without a timezone as UTC", async () => {
    const sqlite = database();
    const userId = seedUser(sqlite);
    sqlite.exec(
      `INSERT INTO machines (user_id, machine_id, last_seen) VALUES (${userId}, 'mac-legacy', '2026-09-10T00:00:00.000Z')`,
    );

    await expect(
      summarizeUsage(
        sqlite.asD1(),
        "octocat",
        "day",
        new Date("2026-09-11T00:30:00.000Z"),
      ),
    ).resolves.toMatchObject({
      timezone: "UTC",
      to: "2026-09-11",
    });
  });

  it("backfills machines written before the timezone migration as UTC", async () => {
    const sqlite = new SqliteD1TestDatabase();
    databases.push(sqlite);
    sqlite.applyMigrations(["0001_create_usage.sql"]);
    const userId = seedUser(sqlite);
    sqlite.exec(
      `INSERT INTO machines (user_id, machine_id, last_seen) VALUES (${userId}, 'mac-legacy', '2026-09-10T00:00:00.000Z')`,
    );
    sqlite.exec(
      `INSERT INTO usage_days (user_id, machine_id, date, provider, model, input, output, cache_create, cache_read, cost_usd)
       VALUES (${userId}, 'mac-legacy', '2026-09-10', 'anthropic', 'claude-opus-5', 5, 0, 0, 0, 5),
              (${userId}, 'mac-legacy', '2026-09-11', 'anthropic', 'claude-opus-5', 6, 0, 0, 0, 6)`,
    );
    sqlite.applyMigrations(["0002_add_machine_timezone.sql"]);

    expect(sqlite.query("SELECT timezone FROM machines")).toEqual([
      { timezone: "UTC" },
    ]);
    await expect(
      summarizeUsage(sqlite.asD1(), "octocat", "day", now),
    ).resolves.toMatchObject({
      timezone: "UTC",
      from: "2026-09-10",
      to: "2026-09-10",
      totals: { input: 5 },
    });
  });
});
