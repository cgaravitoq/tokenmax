import { homedir } from "node:os";
import { resolve } from "node:path";

export interface CollectorEnv {
  home: string;
  platform?: NodeJS.Platform;
  tokenmaxHome?: string;
  xdgConfigHome?: string;
  xdgStateHome?: string;
}

export interface CollectorPaths {
  configFile: string;
  plist: string;
  pricesFile: string;
  service: string;
  stderrLog: string;
  stdoutLog: string;
  timer: string;
}

export function processEnv(): CollectorEnv {
  return {
    home: homedir(),
    platform: process.platform,
    tokenmaxHome: process.env.TOKENMAX_HOME,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgStateHome: process.env.XDG_STATE_HOME,
  };
}

function logDirFor(env: CollectorEnv, home: string): string {
  if (env.platform !== "linux") {
    return resolve(home, "Library", "Logs", "tokenmax");
  }
  if (env.tokenmaxHome === undefined && env.xdgStateHome !== undefined) {
    return resolve(env.xdgStateHome, "tokenmax", "logs");
  }
  return resolve(home, ".local", "state", "tokenmax", "logs");
}

export function collectorPaths(env: CollectorEnv): CollectorPaths {
  const home = resolve(env.tokenmaxHome ?? env.home);
  const configHome =
    env.tokenmaxHome === undefined && env.xdgConfigHome !== undefined
      ? resolve(env.xdgConfigHome)
      : resolve(home, ".config");
  const logDir = logDirFor(env, home);
  const unitDir =
    env.xdgConfigHome !== undefined
      ? resolve(env.xdgConfigHome, "systemd", "user")
      : resolve(home, ".config", "systemd", "user");

  return {
    configFile: resolve(configHome, "tokenmax", "config.json"),
    plist: resolve(
      home,
      "Library",
      "LaunchAgents",
      "dev.tokenmax.collector.plist",
    ),
    pricesFile: resolve(configHome, "tokenmax", "litellm-prices.json"),
    service: resolve(unitDir, "tokenmax.service"),
    stderrLog: resolve(logDir, "tokenmax.err.log"),
    stdoutLog: resolve(logDir, "tokenmax.log"),
    timer: resolve(unitDir, "tokenmax.timer"),
  };
}
