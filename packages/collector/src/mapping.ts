import type { AntigravityStep } from "./antigravity";
import { type CcusageDaily, calendarDate } from "./ccusage";
import { costOf, type ModelPrice, type PriceTable } from "./pricing";
import type { UsageDay } from "./usage";

export const antigravityProvider = "antigravity";

const agentModelPrefix = /^\[[^\]]*\]\s*/;

const rowKey = (day: UsageDay): string =>
  `${day.date}\u0000${day.provider}\u0000${day.model}`;

const isEmptyRow = (row: UsageDay): boolean =>
  row.input === 0 &&
  row.output === 0 &&
  row.cache_create === 0 &&
  row.cache_read === 0;

export function mapCcusageDays(output: CcusageDaily): UsageDay[] {
  const rows = new Map<string, UsageDay>();

  for (const day of output.daily) {
    for (const agent of day.agents) {
      for (const breakdown of agent.modelBreakdowns) {
        const row: UsageDay = {
          cache_create: breakdown.cacheCreationTokens,
          cache_read: breakdown.cacheReadTokens,
          cost_usd: breakdown.cost,
          date: day.period,
          input: breakdown.inputTokens,
          model: breakdown.modelName.replace(agentModelPrefix, ""),
          output: breakdown.outputTokens,
          provider: agent.agent,
        };
        if (isEmptyRow(row)) {
          continue;
        }
        const key = rowKey(row);
        const existing = rows.get(key);
        if (existing === undefined) {
          rows.set(key, row);
          continue;
        }
        existing.cache_create += row.cache_create;
        existing.cache_read += row.cache_read;
        existing.cost_usd += row.cost_usd;
        existing.input += row.input;
        existing.output += row.output;
      }
    }
  }

  return sortedRows(rows);
}

interface LocalStep {
  at: Date;
  cacheCreate?: number;
  cacheRead: number;
  input: number;
  model: string;
  output: number;
}

function mapLocalSteps(
  steps: LocalStep[],
  provider: string,
  timezone: string,
  priceOf: (model: string) => ModelPrice | undefined,
): UsageDay[] {
  const rows = new Map<string, UsageDay>();

  for (const step of steps) {
    const row: UsageDay = {
      cache_create: step.cacheCreate ?? 0,
      cache_read: step.cacheRead,
      cost_usd: 0,
      date: calendarDate(step.at, timezone),
      input: step.input,
      model: step.model,
      output: step.output,
      provider,
    };
    if (isEmptyRow(row)) {
      continue;
    }
    const key = rowKey(row);
    const existing = rows.get(key);
    if (existing === undefined) {
      rows.set(key, row);
      continue;
    }
    existing.cache_create += row.cache_create;
    existing.cache_read += row.cache_read;
    existing.input += row.input;
    existing.output += row.output;
  }

  for (const row of rows.values()) {
    const price = priceOf(row.model);
    row.cost_usd =
      price === undefined
        ? 0
        : costOf(price, {
            cacheCreate: row.cache_create,
            cacheRead: row.cache_read,
            input: row.input,
            output: row.output,
          });
  }

  return sortedRows(rows);
}

export function mapAntigravitySteps(
  steps: AntigravityStep[],
  timezone: string,
  prices: PriceTable,
): UsageDay[] {
  return mapLocalSteps(
    steps,
    antigravityProvider,
    timezone,
    (model) => prices.get(model) ?? prices.get(`gemini/${model}`),
  );
}

function sortedRows(rows: Map<string, UsageDay>): UsageDay[] {
  return [...rows.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model),
  );
}
