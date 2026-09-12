import type { CcusageDaily } from "./ccusage";
import type { UsageDay } from "./usage";

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

  return [...rows.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model),
  );
}
