import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CollectorConfig,
  type CollectorTarget,
  canonicalTimezone,
  collectorConfig,
  readConfig,
  runtimeTimezone,
  writeConfig,
} from "./config";
import {
  type CollectorEnv,
  collectorPaths,
  processEnv,
  systemdUserUnitDir,
} from "./paths";
import {
  launchAgentPlist,
  loadCommand,
  type ScheduleOptions,
  type SupportedPlatform,
  systemdService,
  systemdTimer,
} from "./schedule";

export interface ScheduleFile {
  contents: string;
  path: string;
}

export interface InstallPlan {
  config: CollectorConfig;
  configFile: string;
  files: ScheduleFile[];
  loadCommand: string;
}

export interface InstallOptions {
  key: string;
  url: string;
  cliPath?: string;
  dryRun?: boolean;
  env?: CollectorEnv;
  execPath?: string;
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
  timezone?: string;
  uid?: number;
}

const resolvePlatform = (value: NodeJS.Platform): SupportedPlatform => {
  if (value === "darwin" || value === "linux") {
    return value;
  }
  throw new Error(`unsupported platform: ${value}`);
};

const resolveCliPath = (): string =>
  fileURLToPath(new URL("./cli.ts", import.meta.url));

const canonicalUrl = (url: string): string => url.replace(/\/+$/, "");

function scheduleFiles(
  platform: SupportedPlatform,
  paths: { plist: string; service: string; timer: string },
  options: ScheduleOptions,
): ScheduleFile[] {
  if (platform === "darwin") {
    return [{ contents: launchAgentPlist(options), path: paths.plist }];
  }
  return [
    { contents: systemdService(options), path: paths.service },
    { contents: systemdTimer(), path: paths.timer },
  ];
}

async function configuredTargets(
  configFile: string,
): Promise<CollectorTarget[]> {
  const existing = await readConfig(configFile);
  if (existing.kind === "invalid") {
    throw new Error(existing.message);
  }
  return existing.kind === "ok" ? existing.config.targets : [];
}

export async function install(options: InstallOptions): Promise<InstallPlan> {
  const env = options.env ?? processEnv();
  const platform = resolvePlatform(options.platform ?? process.platform);
  const paths = collectorPaths(env);
  const requestedTimezone = options.timezone ?? runtimeTimezone();
  const timezone = canonicalTimezone(requestedTimezone);
  if (timezone === null) {
    throw new Error(`invalid timezone: ${requestedTimezone}`);
  }
  const url = canonicalUrl(options.url);
  const others = (await configuredTargets(paths.configFile)).filter(
    (target) => canonicalUrl(target.url) !== url,
  );
  const config = collectorConfig.parse({
    targets: [...others, { key: options.key, url }],
    timezone,
  });
  const cliPath = options.cliPath ?? resolveCliPath();
  if (
    options.dryRun !== true &&
    (cliPath.includes("/install/cache/") || /\/bunx-\d+-[^/]+\//.test(cliPath))
  ) {
    throw new Error(
      "refusing to schedule from a bunx path; install globally: bun add -g tokenmax-collector, then run: tokenmax install --url <url> --key <key>",
    );
  }
  const files = scheduleFiles(platform, paths, {
    cliPath,
    execPath: options.execPath ?? process.execPath,
    stderrLog: paths.stderrLog,
    stdoutLog: paths.stdoutLog,
  });
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const plan: InstallPlan = {
    config,
    configFile: paths.configFile,
    files,
    loadCommand: loadCommand(platform, paths.plist, uid),
  };
  const log = options.log ?? console.log;

  log(`config: ${plan.configFile} (600, key redacted)`);
  for (const target of plan.config.targets) {
    log(`target: ${target.url}`);
  }
  for (const file of plan.files) {
    log(`schedule: ${file.path}`);
  }
  if (platform === "linux") {
    const unitDir = dirname(paths.service);
    const systemdDir = systemdUserUnitDir(env);
    if (unitDir !== systemdDir) {
      log(
        `warning: systemd will not read units from ${unitDir}; it reads them from ${systemdDir}`,
      );
    }
  }

  if (options.dryRun === true) {
    for (const file of plan.files) {
      log(`--- ${file.path} ---`);
      log(file.contents.trimEnd());
    }
  } else {
    await writeConfig(plan.configFile, plan.config);
    for (const file of plan.files) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.contents);
    }
  }

  log(`load: ${plan.loadCommand}`);
  return plan;
}
