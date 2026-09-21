import {
  type AntigravityStep,
  antigravityConversationsDir,
  readAntigravitySteps,
} from "./antigravity";
import {
  calendarDate,
  readCcusageDaily,
  sinceArgument,
  windowStart,
} from "./ccusage";
import { type CommandRunner, runCommand } from "./command";
import { readConfig, runtimeTimezone } from "./config";
import { type DevinStep, devinTranscriptsDir, readDevinSteps } from "./devin";
import type { Fetcher } from "./http";
import { type MachineIdentity, machineId } from "./machine";
import {
  antigravityProvider,
  devinProvider,
  mapAntigravitySteps,
  mapCcusageDays,
  mapDevinSteps,
} from "./mapping";
import { type CollectorEnv, collectorPaths, processEnv } from "./paths";
import { loadPrices, type PriceTable } from "./pricing";
import type { UsageDay, UsageReport } from "./usage";

export interface CollectOptions {
  identity: MachineIdentity;
  env?: CollectorEnv;
  fetcher?: Fetcher;
  runner?: CommandRunner;
  today?: Date;
  timezone?: string;
}

export type CollectResult =
  | { kind: "reported"; accepted: number; machine: string; warnings: string[] }
  | { kind: "empty"; warnings: string[] }
  | { kind: "missing-config"; configFile: string }
  | { kind: "failed"; message: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const reportUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/api/report`;

function acceptedCount(body: string): number | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("accepted" in payload)
  ) {
    return null;
  }
  const accepted = payload.accepted;
  return typeof accepted === "number" ? accepted : null;
}

interface LocalRows {
  days: UsageDay[];
  warnings: string[];
}

interface LocalSource<Step extends { at: Date }> {
  map: (steps: Step[], timezone: string, prices: PriceTable) => UsageDay[];
  provider: string;
  read: (home: string) => Promise<{ failures: string[]; steps: Step[] }>;
}

interface LocalWindow {
  fetcher: Fetcher;
  home: string;
  pricesFile: string;
  since: string;
  timezone: string;
  today: Date;
}

const antigravitySource: LocalSource<AntigravityStep> = {
  map: mapAntigravitySteps,
  provider: antigravityProvider,
  read: (home) => readAntigravitySteps(antigravityConversationsDir(home)),
};

const devinSource: LocalSource<DevinStep> = {
  map: mapDevinSteps,
  provider: devinProvider,
  read: (home) => readDevinSteps(devinTranscriptsDir(home)),
};

async function report(
  fetcher: Fetcher,
  url: string,
  key: string,
  usage: UsageReport,
  warnings: string[],
): Promise<CollectResult> {
  const response = await fetcher(reportUrl(url), {
    body: JSON.stringify(usage),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const body = await response.text();
  if (response.status !== 200) {
    return {
      kind: "failed",
      message: `tokenmax responded ${response.status}: ${body}`,
    };
  }
  const accepted = acceptedCount(body);
  if (accepted === null) {
    return {
      kind: "failed",
      message: `tokenmax responded an unexpected body: ${body}`,
    };
  }
  return { accepted, kind: "reported", machine: usage.machine, warnings };
}

async function localDays<Step extends { at: Date }>(
  source: LocalSource<Step>,
  window: LocalWindow,
): Promise<LocalRows> {
  try {
    const usage = await source.read(window.home);
    const warnings = usage.failures.map(
      (failure) => `${source.provider}: skipped ${failure}`,
    );
    const steps = usage.steps.filter(
      (step) => calendarDate(step.at, window.timezone) >= window.since,
    );
    if (steps.length === 0) {
      return { days: [], warnings };
    }
    const prices = await loadPrices(
      window.fetcher,
      window.pricesFile,
      window.today,
    );
    return { days: source.map(steps, window.timezone, prices), warnings };
  } catch (error) {
    return {
      days: [],
      warnings: [`${source.provider}: ${messageOf(error)}`],
    };
  }
}

export async function collect(options: CollectOptions): Promise<CollectResult> {
  const env = options.env ?? processEnv();
  const paths = collectorPaths(env);
  const config = await readConfig(paths.configFile);
  if (config.kind === "missing") {
    return { configFile: paths.configFile, kind: "missing-config" };
  }
  if (config.kind === "invalid") {
    return { kind: "failed", message: config.message };
  }

  const machine = machineId(
    options.identity.hostname,
    options.identity.platformUuid,
  );
  const timezone =
    config.config.timezone ?? options.timezone ?? runtimeTimezone();
  const runner = options.runner ?? runCommand;
  const fetcher = options.fetcher ?? fetch;
  const today = options.today ?? new Date();

  let days: UsageDay[];
  try {
    const daily = await readCcusageDaily(
      runner,
      sinceArgument(today, timezone),
      timezone,
    );
    days = mapCcusageDays(daily);
  } catch (error) {
    return { kind: "failed", message: messageOf(error) };
  }

  const window: LocalWindow = {
    fetcher,
    home: env.home,
    pricesFile: paths.pricesFile,
    since: windowStart(today, timezone),
    timezone,
    today,
  };
  const antigravity = await localDays(antigravitySource, window);
  const devin = await localDays(devinSource, window);
  days.push(...antigravity.days, ...devin.days);
  const warnings = [...antigravity.warnings, ...devin.warnings];
  if (days.length === 0) {
    return { kind: "empty", warnings };
  }

  try {
    return await report(
      fetcher,
      config.config.url,
      config.config.key,
      { days, machine, timezone },
      warnings,
    );
  } catch (error) {
    return { kind: "failed", message: messageOf(error) };
  }
}
