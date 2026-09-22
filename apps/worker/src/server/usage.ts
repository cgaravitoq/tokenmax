export const usageRanges = ["day", "week", "month"] as const;

export type UsageRange = (typeof usageRanges)[number];

export interface UsageDayReport {
  date: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  cost_usd: number;
}

export interface UsageReport {
  machine: string;
  timezone?: string;
  days: UsageDayReport[];
}

export interface UsageTotals {
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  tokens: number;
  cost_usd: number;
}

export interface UsageModelSummary {
  model: string;
  tokens: number;
  cost_usd: number;
}

export interface UsageProviderSummary {
  provider: string;
  tokens: number;
  cost_usd: number;
  models: UsageModelSummary[];
}

export interface UsageDaySummary {
  date: string;
  tokens: number;
  cost_usd: number;
}

export interface UsageSummary {
  login: string;
  range: UsageRange;
  from: string;
  to: string;
  timezone: string;
  totals: UsageTotals;
  providers: UsageProviderSummary[];
  days: UsageDaySummary[];
}

interface UsageRow {
  date: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  cost_usd: number;
}

interface UsageAmount {
  tokens: number;
  cost_usd: number;
}

interface ProviderUsage extends UsageAmount {
  models: Map<string, UsageAmount>;
}

const platformUuid =
  /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const linuxMachineId = /[0-9a-f]{32}$/;

/** A collector old enough to prefix the identifier with the hostname reports one
 * machine under a new id on every network it joins, so the suffix rules. */
export function canonicalMachineId(machine: string): string {
  return (
    platformUuid.exec(machine)?.[0] ??
    linuxMachineId.exec(machine)?.[0] ??
    machine
  );
}

const encoder = new TextEncoder();

const batchLimit = 1000;

async function runBatches(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (let start = 0; start < statements.length; start += batchLimit) {
    await db.batch(statements.slice(start, start + batchLimit));
  }
}

const upsertDaySql = `INSERT INTO usage_days (
  user_id, machine_id, date, provider, model, input, output, cache_create,
  cache_read, cost_usd
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, machine_id, date, provider, model) DO UPDATE SET
  input = excluded.input,
  output = excluded.output,
  cache_create = excluded.cache_create,
  cache_read = excluded.cache_read,
  cost_usd = excluded.cost_usd,
  updated_at = CURRENT_TIMESTAMP`;

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function authenticateApiKey(
  db: D1Database,
  key: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      "SELECT user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL",
    )
    .bind(await hashApiKey(key))
    .first<{ user_id: number }>();
  return row?.user_id ?? null;
}

export async function recordUsage(
  db: D1Database,
  userId: number,
  report: UsageReport,
  now: Date,
): Promise<void> {
  const timezone = report.timezone ?? "UTC";
  const machine = canonicalMachineId(report.machine);

  await runBatches(db, [
    db
      .prepare(
        "DELETE FROM usage_days WHERE user_id = ? AND machine_id = ? AND (SELECT timezone FROM machines WHERE user_id = ? AND machine_id = ?) <> ?",
      )
      .bind(userId, machine, userId, machine, timezone),
    db
      .prepare(
        "INSERT INTO machines (user_id, machine_id, last_seen, timezone) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, machine_id) DO UPDATE SET last_seen = excluded.last_seen, timezone = excluded.timezone",
      )
      .bind(userId, machine, now.toISOString(), timezone),
    ...report.days.map((day) =>
      db
        .prepare(upsertDaySql)
        .bind(
          userId,
          machine,
          day.date,
          day.provider,
          day.model,
          day.input,
          day.output,
          day.cache_create,
          day.cache_read,
          day.cost_usd,
        ),
    ),
  ]);
}

async function findUserId(
  db: D1Database,
  login: string,
): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM users WHERE github_login = ?")
    .bind(login)
    .first<{ id: number }>();
  return row?.id ?? null;
}

function rangeDays(range: UsageRange): number {
  if (range === "day") return 1;
  if (range === "week") return 7;
  return 30;
}

function windowFor(range: UsageRange, now: Date, timezone: string) {
  const to = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = to.split("-").map(Number);
  const from = new Date(
    Date.UTC(year, month - 1, day - (rangeDays(range) - 1)),
  );
  return { from: from.toISOString().slice(0, 10), to };
}

async function machineTimezone(
  db: D1Database,
  userId: number,
): Promise<string> {
  const row = await db
    .prepare(
      "SELECT timezone FROM machines WHERE user_id = ? ORDER BY last_seen DESC, machine_id LIMIT 1",
    )
    .bind(userId)
    .first<{ timezone: string }>();
  return row?.timezone ?? "UTC";
}

function ranked<K extends string, V extends UsageAmount>(
  entries: Map<K, V>,
): [K, V][] {
  return [...entries].sort(
    ([aName, a], [bName, b]) =>
      b.tokens - a.tokens || aName.localeCompare(bName),
  );
}

export async function summarizeUsage(
  db: D1Database,
  login: string,
  range: UsageRange,
  now: Date,
): Promise<UsageSummary | null> {
  const userId = await findUserId(db, login);
  if (userId === null) return null;

  const timezone = await machineTimezone(db, userId);
  const { from, to } = windowFor(range, now, timezone);
  const rows = await db
    .prepare(
      `SELECT date, provider, model, SUM(input) AS input, SUM(output) AS output,
        SUM(cache_create) AS cache_create, SUM(cache_read) AS cache_read,
        SUM(cost_usd) AS cost_usd
      FROM usage_days
      WHERE user_id = ? AND date >= ? AND date <= ?
      GROUP BY date, provider, model`,
    )
    .bind(userId, from, to)
    .all<UsageRow>();

  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cache_create: 0,
    cache_read: 0,
    tokens: 0,
    cost_usd: 0,
  };
  const providers = new Map<string, ProviderUsage>();
  const days = new Map<string, UsageAmount>();

  for (const row of rows.results) {
    const tokens = row.input + row.output + row.cache_create + row.cache_read;
    totals.input += row.input;
    totals.output += row.output;
    totals.cache_create += row.cache_create;
    totals.cache_read += row.cache_read;
    totals.tokens += tokens;
    totals.cost_usd += row.cost_usd;

    const provider = providers.get(row.provider) ?? {
      tokens: 0,
      cost_usd: 0,
      models: new Map<string, UsageAmount>(),
    };
    provider.tokens += tokens;
    provider.cost_usd += row.cost_usd;
    const model = provider.models.get(row.model) ?? { tokens: 0, cost_usd: 0 };
    model.tokens += tokens;
    model.cost_usd += row.cost_usd;
    provider.models.set(row.model, model);
    providers.set(row.provider, provider);

    const day = days.get(row.date) ?? { tokens: 0, cost_usd: 0 };
    day.tokens += tokens;
    day.cost_usd += row.cost_usd;
    days.set(row.date, day);
  }

  return {
    login,
    range,
    from,
    to,
    timezone,
    totals,
    providers: ranked(providers).map(([provider, usage]) => ({
      provider,
      tokens: usage.tokens,
      cost_usd: usage.cost_usd,
      models: ranked(usage.models).map(([model, modelUsage]) => ({
        model,
        tokens: modelUsage.tokens,
        cost_usd: modelUsage.cost_usd,
      })),
    })),
    days: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, usage]) => ({
        date,
        tokens: usage.tokens,
        cost_usd: usage.cost_usd,
      })),
  };
}
