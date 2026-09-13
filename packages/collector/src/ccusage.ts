import { createRequire } from "node:module";
import { z } from "zod";
import type { CommandRunner } from "./command";

const modelBreakdown = z.object({
  cacheCreationTokens: z.int(),
  cacheReadTokens: z.int(),
  cost: z.number(),
  inputTokens: z.int(),
  modelName: z.string(),
  outputTokens: z.int(),
});

const agentUsage = z.object({
  agent: z.string(),
  modelBreakdowns: z.array(modelBreakdown),
});

const dailyUsage = z.object({
  agents: z.array(agentUsage),
  period: z.string(),
});

const ccusageDaily = z.object({
  daily: z.array(dailyUsage),
});

export type CcusageDaily = z.infer<typeof ccusageDaily>;

const windowDays = 14;

export function parseCcusageDaily(source: string): CcusageDaily {
  return ccusageDaily.parse(JSON.parse(source));
}

export function ccusageCliPath(): string {
  return createRequire(import.meta.url).resolve("ccusage/src/cli.js");
}

export function calendarDate(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function windowStart(today: Date, timezone: string): string {
  const [year, month, day] = calendarDate(today, timezone)
    .split("-")
    .map(Number);
  const start = new Date(Date.UTC(year, month - 1, day - (windowDays - 1)));
  return start.toISOString().slice(0, 10);
}

export function sinceArgument(today: Date, timezone: string): string {
  return windowStart(today, timezone).replaceAll("-", "");
}

export function ccusageArguments(since: string, timezone: string): string[] {
  return [
    "daily",
    "--json",
    "--breakdown",
    "--by-agent",
    "-z",
    timezone,
    "--since",
    since,
  ];
}

export async function readCcusageDaily(
  runner: CommandRunner,
  since: string,
  timezone: string,
): Promise<CcusageDaily> {
  const result = await runner(process.execPath, [
    ccusageCliPath(),
    ...ccusageArguments(since, timezone),
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `ccusage exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return parseCcusageDaily(result.stdout);
}
