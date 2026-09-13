import { readCcusageDaily, sinceArgument } from "./ccusage";
import { type CommandRunner, runCommand } from "./command";
import { readConfig, runtimeTimezone } from "./config";
import type { Fetcher } from "./http";
import { type MachineIdentity, machineId } from "./machine";
import { mapCcusageDays } from "./mapping";
import { type CollectorEnv, collectorPaths, processEnv } from "./paths";
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
  | { kind: "reported"; accepted: number; machine: string }
  | { kind: "empty" }
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

async function report(
  fetcher: Fetcher,
  url: string,
  key: string,
  usage: UsageReport,
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
  return { accepted, kind: "reported", machine: usage.machine };
}

export async function collect(options: CollectOptions): Promise<CollectResult> {
  const paths = collectorPaths(options.env ?? processEnv());
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

  let days: UsageDay[];
  try {
    const daily = await readCcusageDaily(
      runner,
      sinceArgument(options.today ?? new Date(), timezone),
      timezone,
    );
    days = mapCcusageDays(daily);
  } catch (error) {
    return { kind: "failed", message: messageOf(error) };
  }
  if (days.length === 0) {
    return { kind: "empty" };
  }

  try {
    return await report(
      options.fetcher ?? fetch,
      config.config.url,
      config.config.key,
      { days, machine, timezone },
    );
  } catch (error) {
    return { kind: "failed", message: messageOf(error) };
  }
}
