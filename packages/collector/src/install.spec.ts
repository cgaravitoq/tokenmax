import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { install } from "./install";
import { collectorPaths } from "./paths";

const execPath = "/opt/bun/bin/bun";
const cliPath = "/repo/packages/tokenmax-collector/src/cli.ts";
const bunxCliPath =
  "/private/var/folders/test/cache/T/bunx-501-tokenmax-collector@latest/node_modules/tokenmax-collector/src/cli.ts";
const cacheCliPath =
  "/tmp/tokenmax-bun/install/cache/tokenmax-collector/src/cli.ts";
const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const homes: string[] = [];

const makeHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "tokenmax-install-"));
  homes.push(home);
  return home;
};

const plistFor = (
  home: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.tokenmax.collector</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execPath}</string>
    <string>${cliPath}</string>
    <string>collect</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${home}/Library/Logs/tokenmax/tokenmax.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/Library/Logs/tokenmax/tokenmax.err.log</string>
</dict>
</plist>
`;

const serviceFor = (): string => `[Unit]
Description=Report local token usage to tokenmax

[Service]
Type=oneshot
ExecStart="${execPath}" "${cliPath}" collect
`;

const timerFor = (): string => `[Unit]
Description=Report local token usage to tokenmax every five minutes

[Timer]
Unit=tokenmax.service
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
`;

afterAll(async () => {
  for (const home of homes) {
    await rm(home, { force: true, recursive: true });
  }
});

describe("install", () => {
  it("writes the config and the launch agent", async () => {
    const home = await makeHome();
    const paths = collectorPaths({ home });
    const lines: string[] = [];

    const plan = await install({
      cliPath,
      env: { home },
      execPath,
      key: "tmx_secret_value",
      log: (line) => lines.push(line),
      platform: "darwin",
      uid: 501,
      url: "http://localhost:8797",
    });

    expect(plan.configFile).toBe(paths.configFile);
    expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(paths.configFile, "utf8"))).toEqual({
      targets: [{ key: "tmx_secret_value", url: "http://localhost:8797" }],
      timezone: machineZone,
    });
    expect(await readFile(paths.plist, "utf8")).toBe(plistFor(home));
    expect(lines).toEqual([
      `config: ${paths.configFile} (600, key redacted)`,
      "target: http://localhost:8797",
      `schedule: ${paths.plist}`,
      `load: launchctl bootstrap gui/501 ${paths.plist}`,
    ]);
  });

  it("writes the requested timezone into the config", async () => {
    const home = await makeHome();
    const paths = collectorPaths({ home });

    await install({
      cliPath,
      env: { home },
      execPath,
      key: "tmx_secret_value",
      platform: "darwin",
      timezone: "Europe/Madrid",
      uid: 501,
      url: "http://localhost:8797",
    });

    expect(JSON.parse(await readFile(paths.configFile, "utf8"))).toEqual({
      targets: [{ key: "tmx_secret_value", url: "http://localhost:8797" }],
      timezone: "Europe/Madrid",
    });
  });

  it("adds a target for a new url and keeps the existing ones", async () => {
    const home = await makeHome();
    const paths = collectorPaths({ home });
    const lines: string[] = [];
    const base = {
      cliPath,
      env: { home },
      execPath,
      platform: "darwin" as const,
      uid: 501,
    };
    await install({ ...base, key: "tmx_first", url: "http://localhost:8797" });

    await install({
      ...base,
      key: "otv_second",
      log: (line) => lines.push(line),
      timezone: "Europe/Madrid",
      url: "https://tv.example",
    });

    expect(JSON.parse(await readFile(paths.configFile, "utf8"))).toEqual({
      targets: [
        { key: "tmx_first", url: "http://localhost:8797" },
        { key: "otv_second", url: "https://tv.example" },
      ],
      timezone: "Europe/Madrid",
    });
    expect(lines.slice(0, 3)).toEqual([
      `config: ${paths.configFile} (600, key redacted)`,
      "target: http://localhost:8797",
      "target: https://tv.example",
    ]);
  });

  it("replaces the key of a url already configured", async () => {
    const home = await makeHome();
    const paths = collectorPaths({ home });
    const base = {
      cliPath,
      env: { home },
      execPath,
      platform: "darwin" as const,
      uid: 501,
    };
    await install({ ...base, key: "tmx_first", url: "http://localhost:8797" });
    await install({ ...base, key: "otv_second", url: "https://tv.example" });

    await install({
      ...base,
      key: "tmx_rotated",
      url: "http://localhost:8797",
    });

    expect(
      JSON.parse(await readFile(paths.configFile, "utf8")).targets,
    ).toEqual([
      { key: "otv_second", url: "https://tv.example" },
      { key: "tmx_rotated", url: "http://localhost:8797" },
    ]);
  });

  it("stores the canonical spelling of a non-machine zone", async () => {
    const home = await makeHome();
    const paths = collectorPaths({ home });

    await install({
      cliPath,
      env: { home },
      execPath,
      key: "tmx_secret_value",
      platform: "darwin",
      timezone: "america/los_angeles",
      uid: 501,
      url: "http://localhost:8797",
    });

    expect(JSON.parse(await readFile(paths.configFile, "utf8")).timezone).toBe(
      "America/Los_Angeles",
    );
  });

  it("refuses an invalid timezone without writing anything", async () => {
    const home = await makeHome();

    await expect(
      install({
        cliPath,
        env: { home },
        execPath,
        key: "tmx_secret_value",
        platform: "darwin",
        timezone: "Mars/Olympus",
        uid: 501,
        url: "http://localhost:8797",
      }),
    ).rejects.toThrow(/invalid timezone: Mars\/Olympus/);

    expect(await readdir(home)).toEqual([]);
  });

  it("prints the systemd load command without running it", async () => {
    const home = await makeHome();
    const paths = collectorPaths({ home });
    const lines: string[] = [];

    await install({
      cliPath,
      env: { home },
      execPath,
      key: "tmx_secret_value",
      log: (line) => lines.push(line),
      platform: "linux",
      url: "http://localhost:8797",
    });

    expect(await readFile(paths.service, "utf8")).toBe(serviceFor());
    expect(await readFile(paths.timer, "utf8")).toBe(timerFor());
    expect(lines).toEqual([
      `config: ${paths.configFile} (600, key redacted)`,
      "target: http://localhost:8797",
      `schedule: ${paths.service}`,
      `schedule: ${paths.timer}`,
      "load: systemctl --user enable --now tokenmax.timer",
    ]);
  });

  it("writes the units under XDG_CONFIG_HOME and prints that unit name", async () => {
    const home = await makeHome();
    const xdgConfigHome = join(home, "xdg");
    const lines: string[] = [];
    const paths = collectorPaths({ home, xdgConfigHome });

    const plan = await install({
      cliPath,
      env: { home, xdgConfigHome },
      execPath,
      key: "tmx_secret_value",
      log: (line) => lines.push(line),
      platform: "linux",
      url: "http://localhost:8797",
    });

    expect(paths.service).toBe(`${home}/xdg/systemd/user/tokenmax.service`);
    expect(paths.timer).toBe(`${home}/xdg/systemd/user/tokenmax.timer`);
    expect(plan.files.map((file) => file.path)).toEqual([
      paths.service,
      paths.timer,
    ]);
    expect(await readFile(paths.timer, "utf8")).toBe(timerFor());
    expect(lines.at(-1)).toBe(
      `load: systemctl --user enable --now ${basename(paths.timer)}`,
    );
  });

  it("prints the files without writing them on a dry run", async () => {
    const home = await makeHome();
    const paths = collectorPaths({ home });
    const lines: string[] = [];

    await install({
      cliPath,
      dryRun: true,
      env: { home },
      execPath,
      key: "tmx_secret_value",
      log: (line) => lines.push(line),
      platform: "darwin",
      uid: 501,
      url: "http://localhost:8797",
    });

    expect(await readdir(home)).toEqual([]);
    expect(lines).toEqual([
      `config: ${paths.configFile} (600, key redacted)`,
      "target: http://localhost:8797",
      `schedule: ${paths.plist}`,
      `--- ${paths.plist} ---`,
      plistFor(home).trimEnd(),
      `load: launchctl bootstrap gui/501 ${paths.plist}`,
    ]);
  });

  it.each([bunxCliPath, cacheCliPath])(
    "refuses to schedule from an ephemeral path",
    async (ephemeralCliPath) => {
      const home = await makeHome();

      await expect(
        install({
          cliPath: ephemeralCliPath,
          env: { home },
          execPath,
          key: "tmx_secret_value",
          platform: "darwin",
          uid: 501,
          url: "http://localhost:8797",
        }),
      ).rejects.toThrow(
        "refusing to schedule from a bunx path; install globally: bun add -g tokenmax-collector, then run: tokenmax install --url <url> --key <key>",
      );

      expect(await readdir(home)).toEqual([]);
    },
  );

  it.each([bunxCliPath, cacheCliPath])(
    "prints an ephemeral path during a dry run",
    async (ephemeralCliPath) => {
      const home = await makeHome();
      const lines: string[] = [];

      const plan = await install({
        cliPath: ephemeralCliPath,
        dryRun: true,
        env: { home },
        execPath,
        key: "tmx_secret_value",
        log: (line) => lines.push(line),
        platform: "darwin",
        uid: 501,
        url: "http://localhost:8797",
      });

      expect(plan.files[0]?.contents).toContain(ephemeralCliPath);
      expect(lines).toContain(plan.files[0]?.contents.trimEnd());
      expect(await readdir(home)).toEqual([]);
    },
  );

  it("accepts a globally installed path", async () => {
    const home = await makeHome();
    const paths = collectorPaths({ home });
    const globalCliPath =
      "/tmp/tokenmax-bun/install/global/node_modules/tokenmax-collector/src/cli.ts";

    const plan = await install({
      cliPath: globalCliPath,
      env: { home },
      execPath,
      key: "tmx_secret_value",
      platform: "darwin",
      uid: 501,
      url: "http://localhost:8797",
    });

    expect(plan.files[0]?.path).toBe(paths.plist);
    expect(await readFile(paths.plist, "utf8")).toContain(globalCliPath);
    expect(JSON.parse(await readFile(paths.configFile, "utf8"))).toEqual({
      targets: [{ key: "tmx_secret_value", url: "http://localhost:8797" }],
      timezone: machineZone,
    });
  });

  it("refuses a platform it cannot schedule", async () => {
    const home = await makeHome();
    await expect(
      install({
        cliPath,
        env: { home },
        execPath,
        key: "tmx_secret_value",
        platform: "win32",
        url: "http://localhost:8797",
      }),
    ).rejects.toThrow(/unsupported platform: win32/);
  });

  it("refuses a keyless config", async () => {
    const home = await makeHome();
    await expect(
      install({
        cliPath,
        env: { home },
        execPath,
        key: "",
        platform: "darwin",
        url: "http://localhost:8797",
      }),
    ).rejects.toThrow(/key/);
  });
});

describe("collectorPaths", () => {
  it("redirects every path under TOKENMAX_HOME", () => {
    const paths = collectorPaths({
      home: "/tmp/unused",
      tokenmaxHome: "/tmp/tokenmax-p4",
    });

    expect(paths.configFile).toBe(
      "/tmp/tokenmax-p4/.config/tokenmax/config.json",
    );
    expect(paths.plist).toBe(
      "/tmp/tokenmax-p4/Library/LaunchAgents/dev.tokenmax.collector.plist",
    );
    expect(paths.stdoutLog).toBe(
      "/tmp/tokenmax-p4/Library/Logs/tokenmax/tokenmax.log",
    );
    expect(paths.stderrLog).toBe(
      "/tmp/tokenmax-p4/Library/Logs/tokenmax/tokenmax.err.log",
    );
    expect(paths.service).toBe(
      "/tmp/tokenmax-p4/.config/systemd/user/tokenmax.service",
    );
    expect(paths.timer).toBe(
      "/tmp/tokenmax-p4/.config/systemd/user/tokenmax.timer",
    );
  });

  it("honours XDG_CONFIG_HOME", () => {
    expect(collectorPaths({ home: "/home/u" }).configFile).toBe(
      "/home/u/.config/tokenmax/config.json",
    );
    expect(
      collectorPaths({ home: "/home/u", xdgConfigHome: "/xdg" }).configFile,
    ).toBe("/xdg/tokenmax/config.json");
  });
});
