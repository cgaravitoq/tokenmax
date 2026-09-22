import fsp, {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig, writeConfig } from "./config";

let dir: string;
let configFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tokenmax-config-"));
  await mkdir(join(dir, "tokenmax"));
  configFile = join(dir, "tokenmax", "config.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("readConfig", () => {
  it("reads the targets the collector reports to", async () => {
    await writeConfig(configFile, {
      targets: [
        { key: "tmx_a", url: "https://tokenmax.example" },
        { key: "otv_b", url: "https://tv.example" },
      ],
      timezone: "Europe/Madrid",
    });

    expect(await readConfig(configFile)).toEqual({
      config: {
        targets: [
          { key: "tmx_a", url: "https://tokenmax.example" },
          { key: "otv_b", url: "https://tv.example" },
        ],
        timezone: "Europe/Madrid",
      },
      kind: "ok",
    });
  });

  it("reads a single-target config written before targets existed", async () => {
    await writeFile(
      configFile,
      JSON.stringify({
        key: "tmx_a",
        timezone: "Europe/Madrid",
        url: "https://tokenmax.example",
      }),
    );

    expect(await readConfig(configFile)).toEqual({
      config: {
        targets: [{ key: "tmx_a", url: "https://tokenmax.example" }],
        timezone: "Europe/Madrid",
      },
      kind: "ok",
    });
  });

  it("rejects a config without targets", async () => {
    await writeFile(configFile, JSON.stringify({ targets: [] }));

    expect(await readConfig(configFile)).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining(
        `invalid tokenmax config at ${configFile}`,
      ),
    });
  });

  it("rejects a target without a key", async () => {
    await writeFile(
      configFile,
      JSON.stringify({
        targets: [{ key: "", url: "https://tokenmax.example" }],
      }),
    );

    expect(await readConfig(configFile)).toMatchObject({ kind: "invalid" });
  });

  it("rejects a non-canonical stored timezone with a named error", async () => {
    await writeFile(
      configFile,
      JSON.stringify({
        targets: [{ key: "tmx_a", url: "https://tokenmax.example" }],
        timezone: "Mars/Olympus",
      }),
    );

    expect(await readConfig(configFile)).toEqual({
      kind: "invalid",
      message: `invalid tokenmax config at ${configFile}: timezone: invalid timezone`,
    });
  });

  it("is missing when there is no file", async () => {
    expect(await readConfig(configFile)).toEqual({ kind: "missing" });
  });
});

describe("writeConfig", () => {
  it("writes the targets shape", async () => {
    await writeConfig(configFile, {
      targets: [{ key: "tmx_a", url: "https://tokenmax.example" }],
    });

    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      targets: [{ key: "tmx_a", url: "https://tokenmax.example" }],
    });
  });

  it("creates the config with mode 0600 in its single write", async () => {
    const spy = vi.spyOn(fsp, "writeFile");
    try {
      await writeConfig(configFile, {
        targets: [{ key: "tmx_a", url: "https://tokenmax.example" }],
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual([
        `${configFile}.tmp`,
        expect.any(String),
        { mode: 0o600 },
      ]);
    } finally {
      spy.mockRestore();
    }

    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      targets: [{ key: "tmx_a", url: "https://tokenmax.example" }],
    });
  });

  it("narrows a config file that was already wider", async () => {
    await writeFile(configFile, "{}\n");
    await chmod(configFile, 0o644);
    const spy = vi.spyOn(fsp, "writeFile");
    try {
      await writeConfig(configFile, {
        targets: [{ key: "tmx_a", url: "https://tokenmax.example" }],
      });

      expect(spy.mock.calls.map((call) => call[0])).toEqual([
        `${configFile}.tmp`,
      ]);
    } finally {
      spy.mockRestore();
    }

    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      targets: [{ key: "tmx_a", url: "https://tokenmax.example" }],
    });
  });
});
