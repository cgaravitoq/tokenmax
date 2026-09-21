#!/usr/bin/env bun
import { Command } from "commander";
import { collect } from "./collect";
import type { CommandRunner } from "./command";
import type { Fetcher } from "./http";
import { install } from "./install";
import { type MachineIdentity, readMachineIdentity } from "./machine";
import { type CollectorEnv, processEnv } from "./paths";

export interface CliIo {
  stderr: (line: string) => void;
  stdout: (line: string) => void;
  cliPath?: string;
  env?: CollectorEnv;
  execPath?: string;
  fetcher?: Fetcher;
  identity?: MachineIdentity;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  today?: Date;
  uid?: number;
}

interface InstallCommandOptions {
  dryRun: boolean;
  key: string;
  timezone?: string;
  url: string;
}

async function runCollect(io: CliIo): Promise<number> {
  const result = await collect({
    env: io.env ?? processEnv(),
    fetcher: io.fetcher,
    identity: io.identity ?? (await readMachineIdentity()),
    runner: io.runner,
    today: io.today,
  });
  if (result.kind === "reported" || result.kind === "empty") {
    for (const warning of result.warnings) {
      io.stderr(warning);
    }
    if (result.kind === "empty") {
      io.stdout("nothing to report");
      return 0;
    }
    let exitCode = 0;
    for (const target of result.targets) {
      if ("accepted" in target) {
        io.stdout(
          `accepted ${target.accepted} days for ${result.machine} at ${target.url}`,
        );
      } else {
        io.stderr(`${target.url}: ${target.message}`);
        exitCode = 1;
      }
    }
    return exitCode;
  }
  if (result.kind === "missing-config") {
    io.stderr(
      `no tokenmax config at ${result.configFile}; run: tokenmax install --url <url> --key <key>`,
    );
    return 2;
  }
  io.stderr(result.message);
  return 1;
}

async function runInstall(
  options: InstallCommandOptions,
  io: CliIo,
): Promise<number> {
  try {
    await install({
      cliPath: io.cliPath,
      dryRun: options.dryRun,
      env: io.env ?? processEnv(),
      execPath: io.execPath,
      key: options.key,
      log: io.stdout,
      platform: io.platform,
      timezone: options.timezone,
      uid: io.uid,
      url: options.url,
    });
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let exitCode = 0;
  const program = new Command()
    .name("tokenmax-collector")
    .description("Report local token usage to a tokenmax instance");

  program
    .command("collect")
    .description("Report local usage from the last 14 days")
    .action(async () => {
      exitCode = await runCollect(io);
    });

  program
    .command("install")
    .description("Write the tokenmax config and the local schedule")
    .requiredOption("--url <url>", "tokenmax base url")
    .requiredOption("--key <key>", "tokenmax api key")
    .option("--timezone <zone>", "IANA timezone, defaults to the machine zone")
    .option("--dry-run", "print the files without writing them", false)
    .action(async (options: InstallCommandOptions) => {
      exitCode = await runInstall(options, io);
    });

  await program.parseAsync(argv, { from: "user" });
  return exitCode;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    stderr: console.error,
    stdout: console.log,
  });
}
