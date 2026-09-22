import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, runCli } from "./cli";
import type { CommandRunner } from "./command";
import { writeConfig } from "./config";
import type { Fetcher } from "./http";
import { type CollectorPaths, collectorPaths } from "./paths";

const identity = { hostname: "test-host", platformUuid: "abc-123" };
const key = "tmx_secret_value";
const url = "http://localhost:8797";
const today = new Date("2026-09-10T12:00:00.000Z");
const sample = await readFile(
  new URL("./test/ccusage-daily.json", import.meta.url),
  "utf8",
);

const runnerWith =
  (stdout: string): CommandRunner =>
  async () => ({ exitCode: 0, stderr: "", stdout });

const fetcherWith =
  (status: number, body: string): Fetcher =>
  async () => ({ status, text: async () => body });

const failingFetch: Fetcher = async () => {
  throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:8797");
};

const failingRunner: CommandRunner = async () => {
  throw new Error("ccusage must not run in this path");
};

interface Run {
  code: number;
  stderr: string[];
  stdout: string[];
}

let home: string;
let paths: CollectorPaths;

const run = async (argv: string[], io: Partial<CliIo> = {}): Promise<Run> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    env: { home },
    identity,
    stderr: (line) => stderr.push(line),
    stdout: (line) => stdout.push(line),
    today,
    ...io,
  });
  return { code, stderr, stdout };
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tokenmax-cli-"));
  paths = collectorPaths({ home });
});

afterEach(async () => {
  await rm(home, { force: true, recursive: true });
});

describe("collect", () => {
  it("prints the accepted days and exits 0", async () => {
    await writeConfig(paths.configFile, { targets: [{ key, url }] });
    const result = await run(["collect"], {
      fetcher: fetcherWith(200, '{"accepted":3}'),
      runner: runnerWith(sample),
    });

    expect(result).toEqual({
      code: 0,
      stderr: [],
      stdout: [`accepted 3 days for abc-123 at ${url}`],
    });
  });

  it("prints one line per target and exits 1 when any target fails", async () => {
    const other = "https://tv.example";
    await writeConfig(paths.configFile, {
      targets: [
        { key, url },
        { key: "otv_other", url: other },
      ],
    });
    const result = await run(["collect"], {
      fetcher: async (requestUrl) =>
        requestUrl.startsWith(other)
          ? { status: 401, text: async () => '{"error":"unauthorized"}' }
          : { status: 200, text: async () => '{"accepted":3}' },
      runner: runnerWith(sample),
    });

    expect(result).toEqual({
      code: 1,
      stderr: [`${other}: tokenmax responded 401: {"error":"unauthorized"}`],
      stdout: [`accepted 3 days for abc-123 at ${url}`],
    });
  });

  it("prints nothing to report and exits 0 without usage", async () => {
    await writeConfig(paths.configFile, { targets: [{ key, url }] });
    const result = await run(["collect"], {
      fetcher: failingFetch,
      runner: runnerWith('{"daily":[]}'),
    });

    expect(result).toEqual({
      code: 0,
      stderr: [],
      stdout: ["nothing to report"],
    });
  });

  it("prints the install command and exits 2 without a config", async () => {
    const result = await run(["collect"], {
      fetcher: failingFetch,
      runner: failingRunner,
    });

    expect(result).toEqual({
      code: 2,
      stderr: [
        `no tokenmax config at ${paths.configFile}; run: tokenmax install --url <url> --key <key>`,
      ],
      stdout: [],
    });
  });

  it("prints the status and the body and exits 1 when the key is rejected", async () => {
    await writeConfig(paths.configFile, { targets: [{ key, url }] });
    const result = await run(["collect"], {
      fetcher: fetcherWith(401, '{"error":"unauthorized"}'),
      runner: runnerWith(sample),
    });

    expect(result).toEqual({
      code: 1,
      stderr: [`${url}: tokenmax responded 401: {"error":"unauthorized"}`],
      stdout: [],
    });
  });

  it("prints the network error and exits 1 when tokenmax is unreachable", async () => {
    await writeConfig(paths.configFile, { targets: [{ key, url }] });
    const result = await run(["collect"], {
      fetcher: failingFetch,
      runner: runnerWith(sample),
    });

    expect(result).toEqual({
      code: 1,
      stderr: [`${url}: fetch failed: ECONNREFUSED 127.0.0.1:8797`],
      stdout: [],
    });
  });
});

describe("install", () => {
  const cliPath = "/repo/packages/tokenmax-collector/src/cli.ts";
  const bunxCliPath =
    "/private/var/folders/test/cache/T/bunx-501-tokenmax-collector@latest/node_modules/tokenmax-collector/src/cli.ts";
  const execPath = "/opt/bun/bin/bun";
  const installIo = {
    cliPath,
    execPath,
    platform: "darwin" as const,
    uid: 501,
  };

  it("writes the files, prints the load command and exits 0", async () => {
    const result = await run(
      ["install", "--url", url, "--key", key, "--timezone", "Europe/Madrid"],
      installIo,
    );

    expect(result).toEqual({
      code: 0,
      stderr: [],
      stdout: [
        `config: ${paths.configFile} (600, key redacted)`,
        `target: ${url}`,
        `schedule: ${paths.plist}`,
        `load: launchctl bootstrap gui/501 ${paths.plist}`,
      ],
    });
    expect(JSON.parse(await readFile(paths.configFile, "utf8"))).toEqual({
      targets: [{ key, url }],
      timezone: "Europe/Madrid",
    });
    expect(await readFile(paths.plist, "utf8")).toContain(
      `<string>${cliPath}</string>`,
    );
  });

  it("writes the canonical spelling of the requested zone", async () => {
    const result = await run(
      [
        "install",
        "--url",
        url,
        "--key",
        key,
        "--timezone",
        "america/los_angeles",
      ],
      installIo,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(paths.configFile, "utf8")).timezone).toBe(
      "America/Los_Angeles",
    );
  });

  it("prints the invalid timezone error and exits 1", async () => {
    const result = await run(
      ["install", "--url", url, "--key", key, "--timezone", "Mars/Olympus"],
      installIo,
    );

    expect(result).toEqual({
      code: 1,
      stderr: ["invalid timezone: Mars/Olympus"],
      stdout: [],
    });
    expect(await readdir(home)).toEqual([]);
  });

  it("prints the bunx path error and exits 1 without writing", async () => {
    const result = await run(["install", "--url", url, "--key", key], {
      ...installIo,
      cliPath: bunxCliPath,
    });

    expect(result).toEqual({
      code: 1,
      stderr: [
        "refusing to schedule from a bunx path; install globally: bun add -g tokenmax-collector, then run: tokenmax install --url <url> --key <key>",
      ],
      stdout: [],
    });
    expect(await readdir(home)).toEqual([]);
  });

  it("prints the files without writing them on a dry run", async () => {
    const result = await run(
      ["install", "--url", url, "--key", key, "--dry-run"],
      installIo,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout.slice(0, 4)).toEqual([
      `config: ${paths.configFile} (600, key redacted)`,
      `target: ${url}`,
      `schedule: ${paths.plist}`,
      `--- ${paths.plist} ---`,
    ]);
    expect(result.stdout.at(-1)).toBe(
      `load: launchctl bootstrap gui/501 ${paths.plist}`,
    );
    expect(await readdir(home)).toEqual([]);
  });

  it("prints the error and exits 1 on a platform it cannot schedule", async () => {
    const result = await run(["install", "--url", url, "--key", key], {
      ...installIo,
      platform: "win32",
    });

    expect(result).toEqual({
      code: 1,
      stderr: ["unsupported platform: win32"],
      stdout: [],
    });
  });
});
