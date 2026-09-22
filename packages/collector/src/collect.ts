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
import { type CollectorTarget, readConfig, runtimeTimezone } from "./config";
import { type DevinStep, devinTranscriptsDir, readDevinSteps } from "./devin";
import type { Fetcher } from "./http";
import { type MachineIdentity, machineId } from "./machine";
import {
  antigravityProvider,
  ccusageProviders,
  devinProvider,
  type MappedDays,
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
  requestTimeoutMs?: number;
  runner?: CommandRunner;
  today?: Date;
  timezone?: string;
}

export type TargetResult =
  | { accepted: number; url: string }
  | { message: string; url: string };

export type CollectResult =
  | {
      kind: "reported";
      machine: string;
      targets: TargetResult[];
      warnings: string[];
    }
  | { kind: "empty"; warnings: string[] }
  | { kind: "missing-config"; configFile: string }
  | { kind: "failed"; message: string; warnings: string[] };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const fetchTimeoutMs = 30_000;
const sliceSize = 1000;

const reportUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/api/report`;

const providerDay = (day: UsageDay): string =>
  `${day.date}\u0000${day.provider}`;

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
  if (
    typeof accepted !== "number" ||
    !Number.isInteger(accepted) ||
    accepted < 0
  ) {
    return null;
  }
  return accepted;
}

interface LocalSource<Step extends { at: Date }> {
  map: (steps: Step[], timezone: string, prices: PriceTable) => MappedDays;
  provider: string;
  read: (home: string) => Promise<{ failures: string[]; steps: Step[] }>;
}

interface LocalWindow {
  fetcher: Fetcher;
  home: string;
  pricesFile: string;
  requestTimeoutMs: number;
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
  target: CollectorTarget,
  body: string,
  requestTimeoutMs: number,
): Promise<TargetResult> {
  const { url } = target;
  try {
    const response = await fetcher(reportUrl(url), {
      body,
      headers: {
        Authorization: `Bearer ${target.key}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const answer = await response.text();
    if (response.status !== 200) {
      return {
        message: `tokenmax responded ${response.status}: ${answer}`,
        url,
      };
    }
    const accepted = acceptedCount(answer);
    if (accepted === null) {
      return {
        message: `tokenmax responded an unexpected body: ${answer}`,
        url,
      };
    }
    return { accepted, url };
  } catch (error) {
    return { message: messageOf(error), url };
  }
}

function daySlices(days: UsageDay[], size: number): UsageDay[][] {
  const groups: UsageDay[][] = [];
  for (const day of days) {
    const group = groups.at(-1);
    if (group !== undefined && group[0].date === day.date) {
      group.push(day);
    } else {
      groups.push([day]);
    }
  }

  const slices: UsageDay[][] = [];
  let current: UsageDay[] = [];
  for (const group of groups) {
    if (current.length > 0 && current.length + group.length > size) {
      slices.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) {
    slices.push(current);
  }
  return slices;
}

async function reportTarget(
  fetcher: Fetcher,
  target: CollectorTarget,
  usage: UsageReport,
  requestTimeoutMs: number,
): Promise<TargetResult> {
  let accepted = 0;
  for (const slice of daySlices(usage.days, sliceSize)) {
    const result = await report(
      fetcher,
      target,
      JSON.stringify({ ...usage, days: slice }),
      requestTimeoutMs,
    );
    if ("message" in result) {
      return result;
    }
    accepted += result.accepted;
  }
  return { accepted, url: target.url };
}

interface LocalDays extends MappedDays {
  providers: string[];
}

async function localDays<Step extends { at: Date }>(
  source: LocalSource<Step>,
  window: LocalWindow,
): Promise<LocalDays> {
  try {
    const usage = await source.read(window.home);
    const warnings = usage.failures.map(
      (failure) => `${source.provider}: skipped ${failure}`,
    );
    const providers = usage.failures.length === 0 ? [source.provider] : [];
    const steps = usage.steps.filter(
      (step) => calendarDate(step.at, window.timezone) >= window.since,
    );
    if (steps.length === 0) {
      return { days: [], providers, warnings };
    }
    const prices = await loadPrices(
      window.fetcher,
      window.pricesFile,
      window.today,
      window.requestTimeoutMs,
    );
    const mapped = source.map(steps, window.timezone, prices);
    return {
      days: mapped.days,
      providers,
      warnings: [...warnings, ...mapped.warnings],
    };
  } catch (error) {
    return {
      days: [],
      providers: [],
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
    return { kind: "failed", message: config.message, warnings: [] };
  }

  const machine = machineId(
    options.identity.hostname,
    options.identity.platformUuid,
  );
  const timezone =
    config.config.timezone ?? options.timezone ?? runtimeTimezone();
  const runner = options.runner ?? runCommand;
  const fetcher = options.fetcher ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? fetchTimeoutMs;
  const today = options.today ?? new Date();

  let days: UsageDay[];
  let ccusageFailure: string | null = null;
  let ccusageCovered: string[] = [];
  try {
    const daily = await readCcusageDaily(
      runner,
      sinceArgument(today, timezone),
      timezone,
    );
    days = mapCcusageDays(daily);
    ccusageCovered = ccusageProviders(daily);
  } catch (error) {
    ccusageFailure = messageOf(error);
    days = [];
  }

  const window: LocalWindow = {
    fetcher,
    home: env.home,
    pricesFile: paths.pricesFile,
    requestTimeoutMs,
    since: windowStart(today, timezone),
    timezone,
    today,
  };
  const antigravity = await localDays(antigravitySource, window);
  const devin = await localDays(devinSource, window);
  const covered = new Set(days.map(providerDay));
  days.push(
    ...[...antigravity.days, ...devin.days].filter(
      (day) => !covered.has(providerDay(day)),
    ),
  );
  days.sort((a, b) => a.date.localeCompare(b.date));
  const warnings =
    ccusageFailure === null ? [] : [`ccusage: ${ccusageFailure}`];
  warnings.push(...antigravity.warnings, ...devin.warnings);
  if (days.length === 0) {
    if (ccusageFailure !== null) {
      return { kind: "failed", message: ccusageFailure, warnings };
    }
    return { kind: "empty", warnings };
  }

  const usage: UsageReport = {
    days,
    machine,
    providers: [
      ...new Set([
        ...ccusageCovered,
        ...antigravity.providers,
        ...devin.providers,
      ]),
    ].sort(),
    timezone,
  };
  const targets: TargetResult[] = [];
  for (const target of config.config.targets) {
    targets.push(await reportTarget(fetcher, target, usage, requestTimeoutMs));
  }
  return { kind: "reported", machine, targets, warnings };
}
