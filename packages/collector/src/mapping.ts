import type { AntigravityStep } from "./antigravity";
import { type CcusageDaily, calendarDate } from "./ccusage";
import type { DevinStep } from "./devin";
import { costOf, type ModelPrice, type PriceTable } from "./pricing";
import type { UsageDay } from "./usage";

export const antigravityProvider = "antigravity";
export const devinProvider = "devin";

const agentModelPrefix = /^\[[^\]]*\]\s*/;
const effortSuffix = /-(low|medium|high|xhigh)$/;
const gptMinorVersion = /^gpt-(\d+)-(\d+)-/;

const litellmModel = (devinModel: string): string =>
  devinModel.replace(effortSuffix, "").replace(gptMinorVersion, "gpt-$1.$2-");

const rowKey = (day: UsageDay): string =>
  `${day.date}\u0000${day.provider}\u0000${day.model}`;

const isEmptyRow = (row: UsageDay): boolean =>
  row.input === 0 &&
  row.output === 0 &&
  row.cache_create === 0 &&
  row.cache_read === 0;

function addRow(rows: Map<string, UsageDay>, row: UsageDay): void {
  const key = rowKey(row);
  const existing = rows.get(key);
  if (existing === undefined) {
    rows.set(key, row);
    return;
  }
  existing.cache_create += row.cache_create;
  existing.cache_read += row.cache_read;
  existing.cost_usd += row.cost_usd;
  existing.input += row.input;
  existing.output += row.output;
}

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
        addRow(rows, row);
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

export interface MappedDays {
  days: UsageDay[];
  warnings: string[];
}

function mapLocalSteps(
  steps: LocalStep[],
  provider: string,
  timezone: string,
  priceOf: (model: string) => ModelPrice | undefined,
): MappedDays {
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
    addRow(rows, row);
  }

  const unpriced = new Set<string>();
  for (const row of rows.values()) {
    const price = priceOf(row.model);
    if (price === undefined) {
      unpriced.add(row.model);
      continue;
    }
    row.cost_usd = costOf(price, {
      cacheCreate: row.cache_create,
      cacheRead: row.cache_read,
      input: row.input,
      output: row.output,
    });
  }

  return {
    days: sortedRows(rows),
    warnings: [...unpriced].map(
      (model) => `${provider}: no price for ${model}`,
    ),
  };
}

export function mapAntigravitySteps(
  steps: AntigravityStep[],
  timezone: string,
  prices: PriceTable,
): MappedDays {
  return mapLocalSteps(
    steps,
    antigravityProvider,
    timezone,
    (model) => prices.get(model) ?? prices.get(`gemini/${model}`),
  );
}

export function mapDevinSteps(
  steps: DevinStep[],
  timezone: string,
  prices: PriceTable,
): MappedDays {
  return mapLocalSteps(
    steps.map((step) => ({ ...step, model: litellmModel(step.model) })),
    devinProvider,
    timezone,
    (model) => prices.get(model),
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
