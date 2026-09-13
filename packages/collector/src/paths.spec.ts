import { describe, expect, it } from "vitest";
import { collectorPaths } from "./paths";

const home = "/home/user";

describe("collectorPaths", () => {
  it("keeps the macOS log directory when the platform is unknown", () => {
    const paths = collectorPaths({ home });

    expect(paths.stdoutLog).toBe(`${home}/Library/Logs/tokenmax/tokenmax.log`);
    expect(paths.stderrLog).toBe(
      `${home}/Library/Logs/tokenmax/tokenmax.err.log`,
    );
  });

  it("keeps the macOS log directory on darwin", () => {
    const paths = collectorPaths({ home, platform: "darwin" });

    expect(paths.stdoutLog).toBe(`${home}/Library/Logs/tokenmax/tokenmax.log`);
    expect(paths.stderrLog).toBe(
      `${home}/Library/Logs/tokenmax/tokenmax.err.log`,
    );
  });

  it("uses the XDG state directory on linux", () => {
    const paths = collectorPaths({
      home,
      platform: "linux",
      xdgStateHome: "/xdg/state",
    });

    expect(paths.stdoutLog).toBe("/xdg/state/tokenmax/logs/tokenmax.log");
    expect(paths.stderrLog).toBe("/xdg/state/tokenmax/logs/tokenmax.err.log");
  });

  it("falls back to the linux default state directory without XDG_STATE_HOME", () => {
    const paths = collectorPaths({ home, platform: "linux" });

    expect(paths.stdoutLog).toBe(
      `${home}/.local/state/tokenmax/logs/tokenmax.log`,
    );
    expect(paths.stderrLog).toBe(
      `${home}/.local/state/tokenmax/logs/tokenmax.err.log`,
    );
  });

  it("prefers TOKENMAX_HOME over XDG_STATE_HOME on linux", () => {
    const paths = collectorPaths({
      home,
      platform: "linux",
      tokenmaxHome: "/tm/home",
      xdgStateHome: "/xdg/state",
    });

    expect(paths.stdoutLog).toBe(
      "/tm/home/.local/state/tokenmax/logs/tokenmax.log",
    );
    expect(paths.configFile).toBe("/tm/home/.config/tokenmax/config.json");
  });

  it("still resolves the config file under XDG_CONFIG_HOME", () => {
    const paths = collectorPaths({
      home,
      platform: "linux",
      xdgConfigHome: "/xdg/config",
      xdgStateHome: "/xdg/state",
    });

    expect(paths.configFile).toBe("/xdg/config/tokenmax/config.json");
    expect(paths.pricesFile).toBe("/xdg/config/tokenmax/litellm-prices.json");
    expect(paths.stdoutLog).toBe("/xdg/state/tokenmax/logs/tokenmax.log");
  });
});
