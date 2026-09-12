import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CollectorConfig,
  canonicalTimezone,
  collectorConfig,
  runtimeTimezone,
  writeConfig,
} from "./config";
import { type CollectorEnv, collectorPaths, processEnv } from "./paths";
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

export async function install(options: InstallOptions): Promise<InstallPlan> {
  const env = options.env ?? processEnv();
  const platform = resolvePlatform(options.platform ?? process.platform);
  const paths = collectorPaths(env);
  const requestedTimezone = options.timezone ?? runtimeTimezone();
  const timezone = canonicalTimezone(requestedTimezone);
  if (timezone === null) {
    throw new Error(`invalid timezone: ${requestedTimezone}`);
  }
  const config = collectorConfig.parse({
    key: options.key,
    timezone,
    url: options.url,
  });
  const files = scheduleFiles(platform, paths, {
    cliPath: options.cliPath ?? resolveCliPath(),
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
  for (const file of plan.files) {
    log(`schedule: ${file.path}`);
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
