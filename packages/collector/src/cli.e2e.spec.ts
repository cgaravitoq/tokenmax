import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectorPaths } from "./paths";
import { launchAgentPlist, systemdService, systemdTimer } from "./schedule";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const bun = basename(process.execPath) === "bun" ? process.execPath : "bun";
const key = "tmx_test";
const url = "http://localhost:1";

const expectSchedule = (file: string, content: string): void => {
  if (basename(file) === "tokenmax.timer") {
    expect(content).toContain("Unit=tokenmax.service");
    expect(content).toContain("OnUnitActiveSec=5min");
    return;
  }
  expect(content).toContain(cliPath);
};

interface Run {
  code: number | null;
  stderr: string;
  stdout: string;
}

let home: string;

const run = (args: string[]): Promise<Run> =>
  new Promise((resolve, reject) => {
    const child = spawn(bun, ["run", cliPath, ...args], {
      env: { ...process.env, TOKENMAX_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }),
    );
  });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tokenmax-e2e-"));
});

afterEach(async () => {
  await rm(home, { force: true, recursive: true });
});

describe("cli entry", () => {
  it("collect exits 2 and prints the install command without a config", async () => {
    const paths = collectorPaths({ home, tokenmaxHome: home });
    const result = await run(["collect"]);

    expect(result).toEqual({
      code: 2,
      stderr: `no tokenmax config at ${paths.configFile}; run: tokenmax install --url <url> --key <key>\n`,
      stdout: "",
    });
  });

  it("install --dry-run exits 0, prints the load command and writes nothing", async () => {
    const result = await run([
      "install",
      "--url",
      url,
      "--key",
      key,
      "--dry-run",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(
      process.platform === "darwin"
        ? /^load: launchctl bootstrap gui\/\d+ .+\.plist$/m
        : /^load: systemctl --user enable --now tokenmax\.timer$/m,
    );
    expect(await readdir(home)).toEqual([]);
  });

  it("install exits 0 and writes the config and the schedule", async () => {
    const paths = collectorPaths({ home, tokenmaxHome: home });
    const result = await run([
      "install",
      "--url",
      url,
      "--key",
      key,
      "--timezone",
      "Europe/Madrid",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(paths.configFile, "utf8"))).toEqual({
      key,
      timezone: "Europe/Madrid",
      url,
    });
    const schedule =
      process.platform === "darwin"
        ? [paths.plist]
        : [paths.service, paths.timer];
    for (const file of schedule) {
      expectSchedule(file, await readFile(file, "utf8"));
    }
  });

  it("install defaults the config timezone to the machine zone", async () => {
    const paths = collectorPaths({ home, tokenmaxHome: home });
    const result = await run(["install", "--url", url, "--key", key]);

    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(paths.configFile, "utf8")).timezone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it("install stores the canonical spelling of the requested zone", async () => {
    const paths = collectorPaths({ home, tokenmaxHome: home });
    const result = await run([
      "install",
      "--url",
      url,
      "--key",
      key,
      "--timezone",
      "america/los_angeles",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(paths.configFile, "utf8")).timezone).toBe(
      "America/Los_Angeles",
    );
  });

  it("install rejects an invalid timezone and writes nothing", async () => {
    const result = await run([
      "install",
      "--url",
      url,
      "--key",
      key,
      "--timezone",
      "Mars/Olympus",
    ]);

    expect(result).toEqual({
      code: 1,
      stderr: "invalid timezone: Mars/Olympus\n",
      stdout: "",
    });
    expect(await readdir(home)).toEqual([]);
  });

  it("renders every platform schedule to the per-file expectations", () => {
    const paths = collectorPaths({ home, tokenmaxHome: home });
    const options = {
      cliPath,
      execPath: process.execPath,
      stderrLog: paths.stderrLog,
      stdoutLog: paths.stdoutLog,
    };

    expectSchedule(paths.plist, launchAgentPlist(options));
    expectSchedule(paths.service, systemdService(options));
    expectSchedule(paths.timer, systemdTimer());
  });
});
