import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { antigravityConversationsDir } from "./antigravity";
import { sinceArgument } from "./ccusage";
import { type CollectResult, collect } from "./collect";
import type { CommandRunner } from "./command";
import { writeConfig } from "./config";
import type { Fetcher } from "./http";
import { type CollectorPaths, collectorPaths } from "./paths";
import { litellmPricesUrl } from "./pricing";
import { writeConversation } from "./test/antigravity-fixture";
import type { UsageDay } from "./usage";

const isCalendarDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

const usageReport = z.object({
  days: z
    .array(
      z.object({
        cache_create: z.int().min(0),
        cache_read: z.int().min(0),
        cost_usd: z.number().min(0),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .refine(isCalendarDate),
        input: z.int().min(0),
        model: z.string().min(1).max(128),
        output: z.int().min(0),
        provider: z.string().min(1).max(64),
      }),
    )
    .min(1)
    .max(2000),
  machine: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  timezone: z.string().min(1),
});

const identity = { hostname: "test-host", platformUuid: "abc-123" };
const key = "tmx_secret_value";
const sample = await readFile(
  new URL("./test/ccusage-daily.json", import.meta.url),
  "utf8",
);
const expectedDays: UsageDay[] = [
  {
    cache_create: 14820642,
    cache_read: 628581555,
    cost_usd: 506.93065499999983,
    date: "2026-09-09",
    input: 10640,
    model: "claude-opus-5",
    output: 2512793,
    provider: "claude",
  },
  {
    cache_create: 10,
    cache_read: 20,
    cost_usd: 0.50217184,
    date: "2026-09-09",
    input: 9963,
    model: "deepseek-v4-flash",
    output: 53,
    provider: "pi",
  },
  {
    cache_create: 0,
    cache_read: 45556480,
    cost_usd: 17.436172,
    date: "2026-09-10",
    input: 2675362,
    model: "gpt-5.6-terra",
    output: 247846,
    provider: "codex",
  },
];

interface Request {
  init: RequestInit;
  url: string;
}

const failingFetch: Fetcher = async () => {
  throw new Error("collect must not report an empty day set");
};

const dailyRunner = (
  stdout: string,
  calls: { args: string[]; command: string }[],
): CommandRunner => {
  return async (command, args) => {
    calls.push({ args, command });
    return { exitCode: 0, stderr: "", stdout };
  };
};

const reportFetcher = (
  requests: Request[],
  status: number,
  body: string,
): Fetcher => {
  return async (url, init) => {
    requests.push({ init, url });
    const parsed = usageReport.safeParse(JSON.parse(String(init.body)));
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
    }
    return { status, text: async () => body };
  };
};

const litellmPrices = JSON.stringify({
  "gemini-3.8-flash": {
    cache_read_input_token_cost: 7.5e-8,
    input_cost_per_token: 7.5e-7,
    output_cost_per_token: 3.75e-6,
  },
});

const pricingFetcher = (report: Fetcher, calls: string[]): Fetcher => {
  return async (url, init) => {
    if (url !== litellmPricesUrl) {
      return report(url, init);
    }
    calls.push(url);
    return { status: 200, text: async () => litellmPrices };
  };
};

let home: string;
let paths: CollectorPaths;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tokenmax-collect-"));
  paths = collectorPaths({ home });
});

afterEach(async () => {
  await rm(home, { force: true, recursive: true });
});

describe("collect", () => {
  it("reports the mapped days to the tokenmax report endpoint", async () => {
    await writeConfig(paths.configFile, {
      key,
      timezone: "Europe/Madrid",
      url: "http://localhost:8797/",
    });
    const calls: { args: string[]; command: string }[] = [];
    const requests: Request[] = [];

    const result = await collect({
      env: { home },
      fetcher: reportFetcher(requests, 200, '{"accepted":3}'),
      identity,
      runner: dailyRunner(sample, calls),
      today: new Date("2026-09-10T23:30:00.000Z"),
    });

    expect(result).toEqual({
      accepted: 3,
      kind: "reported",
      machine: "test-host-abc-123",
      warnings: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args[0]).toMatch(/ccusage[\\/]src[\\/]cli\.js$/);
    expect(calls[0].args.slice(1)).toEqual([
      "daily",
      "--json",
      "--breakdown",
      "--by-agent",
      "-z",
      "Europe/Madrid",
      "--since",
      "20260829",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://localhost:8797/api/report");
    expect(requests[0].init).toMatchObject({
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(String(requests[0].init.body)).not.toContain(key);
    expect(
      usageReport.parse(JSON.parse(String(requests[0].init.body))),
    ).toEqual({
      days: expectedDays,
      machine: "test-host-abc-123",
      timezone: "Europe/Madrid",
    });
  });

  it("reports in the machine zone when the config has none", async () => {
    await writeConfig(paths.configFile, { key, url: "http://localhost:8797" });
    const calls: { args: string[]; command: string }[] = [];
    const requests: Request[] = [];

    const result = await collect({
      env: { home },
      fetcher: reportFetcher(requests, 200, '{"accepted":3}'),
      identity,
      runner: dailyRunner(sample, calls),
      today: new Date("2026-09-10T23:30:00.000Z"),
      timezone: "America/Los_Angeles",
    });

    expect(result).toMatchObject({ kind: "reported" });
    expect(calls[0].args.slice(5, 8)).toEqual([
      "-z",
      "America/Los_Angeles",
      "--since",
    ]);
    expect(calls[0].args[8]).toBe("20260828");
    expect(JSON.parse(String(requests[0].init.body)).timezone).toBe(
      "America/Los_Angeles",
    );
  });

  it("prefers the config zone over the machine zone", async () => {
    await writeConfig(paths.configFile, {
      key,
      timezone: "Europe/Madrid",
      url: "http://localhost:8797",
    });
    const calls: { args: string[]; command: string }[] = [];
    const requests: Request[] = [];

    const result = await collect({
      env: { home },
      fetcher: reportFetcher(requests, 200, '{"accepted":3}'),
      identity,
      runner: dailyRunner(sample, calls),
      today: new Date("2026-09-10T23:30:00.000Z"),
      timezone: "America/Los_Angeles",
    });

    expect(result).toMatchObject({ kind: "reported" });
    expect(calls[0].args.slice(5, 9)).toEqual([
      "-z",
      "Europe/Madrid",
      "--since",
      "20260829",
    ]);
    expect(JSON.parse(String(requests[0].init.body)).timezone).toBe(
      "Europe/Madrid",
    );
  });

  it("adds the Antigravity steps of the window as their own provider", async () => {
    await writeConfig(paths.configFile, {
      key,
      timezone: "Europe/Madrid",
      url: "http://localhost:8797",
    });
    const conversations = antigravityConversationsDir(home);
    await mkdir(conversations, { recursive: true });
    writeConversation(join(conversations, "a.db"), {
      generations: [[1318, "gemini-3.8-flash"]],
      steps: [
        null,
        {
          at: new Date("2026-08-28T21:00:00.000Z"),
          input: 999,
          modelCode: 1318,
          output: 999,
        },
        {
          at: new Date("2026-09-09T22:30:00.000Z"),
          cacheRead: 8144,
          input: 9536,
          modelCode: 1318,
          output: 133,
        },
      ],
    });
    const requests: Request[] = [];
    const priceCalls: string[] = [];

    const result = await collect({
      env: { home },
      fetcher: pricingFetcher(
        reportFetcher(requests, 200, '{"accepted":4}'),
        priceCalls,
      ),
      identity,
      runner: dailyRunner(sample, []),
      today: new Date("2026-09-10T23:30:00.000Z"),
    });

    expect(result).toEqual({
      accepted: 4,
      kind: "reported",
      machine: "test-host-abc-123",
      warnings: [],
    });
    expect(priceCalls).toEqual([litellmPricesUrl]);
    expect(await readFile(paths.pricesFile, "utf8")).toBe(litellmPrices);
    expect(JSON.parse(String(requests[0].init.body)).days).toEqual([
      ...expectedDays,
      {
        cache_create: 0,
        cache_read: 8144,
        cost_usd: 9536 * 7.5e-7 + 133 * 3.75e-6 + 8144 * 7.5e-8,
        date: "2026-09-10",
        input: 9536,
        model: "gemini-3.8-flash",
        output: 133,
        provider: "antigravity",
      },
    ]);
  });

  it("leaves the prices alone when no Antigravity step is in the window", async () => {
    await writeConfig(paths.configFile, { key, url: "http://localhost:8797" });
    const conversations = antigravityConversationsDir(home);
    await mkdir(conversations, { recursive: true });
    writeConversation(join(conversations, "old.db"), {
      steps: [
        {
          at: new Date("2026-08-01T12:00:00.000Z"),
          input: 999,
          modelCode: 1318,
          output: 999,
        },
      ],
    });
    const requests: Request[] = [];
    const priceCalls: string[] = [];

    const result = await collect({
      env: { home },
      fetcher: pricingFetcher(
        reportFetcher(requests, 200, '{"accepted":3}'),
        priceCalls,
      ),
      identity,
      runner: dailyRunner(sample, []),
      today: new Date("2026-09-10T23:30:00.000Z"),
      timezone: "UTC",
    });

    expect(result).toMatchObject({ accepted: 3, kind: "reported" });
    expect(priceCalls).toEqual([]);
    expect(JSON.parse(String(requests[0].init.body)).days).toEqual(
      expectedDays,
    );
  });

  it("still reports the ccusage days when the prices cannot be loaded", async () => {
    await writeConfig(paths.configFile, { key, url: "http://localhost:8797" });
    const conversations = antigravityConversationsDir(home);
    await mkdir(conversations, { recursive: true });
    writeConversation(join(conversations, "a.db"), {
      steps: [
        {
          at: new Date("2026-09-10T12:00:00.000Z"),
          input: 10,
          modelCode: 1318,
          output: 10,
        },
      ],
    });
    const requests: Request[] = [];
    const report = reportFetcher(requests, 200, '{"accepted":3}');

    const result = await collect({
      env: { home },
      fetcher: async (url, init) => {
        if (url === litellmPricesUrl) {
          throw new Error("offline");
        }
        return report(url, init);
      },
      identity,
      runner: dailyRunner(sample, []),
      today: new Date("2026-09-10T23:30:00.000Z"),
    });

    expect(result).toEqual({
      accepted: 3,
      kind: "reported",
      machine: "test-host-abc-123",
      warnings: ["antigravity: could not load model prices: offline"],
    });
    expect(JSON.parse(String(requests[0].init.body)).days).toEqual(
      expectedDays,
    );
  });

  it("reports around a conversation it cannot read and names it", async () => {
    await writeConfig(paths.configFile, { key, url: "http://localhost:8797" });
    const conversations = antigravityConversationsDir(home);
    await mkdir(conversations, { recursive: true });
    await writeFile(join(conversations, "broken.db"), "not a database");
    writeConversation(join(conversations, "ok.db"), {
      generations: [[1318, "gemini-3.8-flash"]],
      steps: [
        {
          at: new Date("2026-09-10T12:00:00.000Z"),
          input: 10,
          modelCode: 1318,
          output: 10,
        },
      ],
    });
    const requests: Request[] = [];

    const result = await collect({
      env: { home },
      fetcher: pricingFetcher(
        reportFetcher(requests, 200, '{"accepted":4}'),
        [],
      ),
      identity,
      runner: dailyRunner(sample, []),
      today: new Date("2026-09-10T23:30:00.000Z"),
    });

    expect(result).toEqual({
      accepted: 4,
      kind: "reported",
      machine: "test-host-abc-123",
      warnings: [
        `antigravity: skipped ${join(conversations, "broken.db")}: file is not a database`,
      ],
    });
    expect(JSON.parse(String(requests[0].init.body)).days).toHaveLength(4);
  });

  it("fails with the status and the body when the key is rejected", async () => {
    await writeConfig(paths.configFile, { key, url: "http://localhost:8797" });
    const requests: Request[] = [];
    const result = await collect({
      env: { home },
      fetcher: reportFetcher(requests, 401, '{"error":"unauthorized"}'),
      identity,
      runner: dailyRunner(sample, []),
      today: new Date("2026-09-10T12:00:00.000Z"),
    });

    expect(result).toEqual({
      kind: "failed",
      message: 'tokenmax responded 401: {"error":"unauthorized"}',
    });
  });

  it("reports nothing without calling tokenmax when there is no usage", async () => {
    await writeConfig(paths.configFile, { key, url: "http://localhost:8797" });
    const result = await collect({
      env: { home },
      fetcher: failingFetch,
      identity,
      runner: dailyRunner('{"daily":[]}', []),
      today: new Date("2026-09-10T12:00:00.000Z"),
    });

    expect(result).toEqual({ kind: "empty", warnings: [] });
  });

  it("fails with the ccusage error when the command exits", async () => {
    await writeConfig(paths.configFile, { key, url: "http://localhost:8797" });
    const result = await collect({
      env: { home },
      fetcher: failingFetch,
      identity,
      runner: async () => ({
        exitCode: 2,
        stderr: "native binary is not available\n",
        stdout: "",
      }),
    });

    expect(result).toEqual({
      kind: "failed",
      message: "ccusage exited with 2: native binary is not available",
    });
  });

  it("fails when the config is not valid json", async () => {
    await writeConfig(paths.configFile, { key, url: "http://x.test" });
    await writeFile(paths.configFile, "{");

    const result = await collect({
      env: { home },
      fetcher: failingFetch,
      identity,
      runner: dailyRunner('{"daily":[]}', []),
    });

    expect(result).toMatchObject({ kind: "failed" });
  });

  it("asks for the install command without a config", async () => {
    const result: CollectResult = await collect({
      env: { home },
      fetcher: failingFetch,
      identity,
      runner: async () => {
        throw new Error("ccusage must not run without a config");
      },
    });

    expect(result).toEqual({
      configFile: paths.configFile,
      kind: "missing-config",
    });
  });
});

describe("sinceArgument", () => {
  const today = new Date("2026-09-10T23:30:00.000Z");

  it("starts the window on the calendar date of the requested zone", () => {
    expect(sinceArgument(today, "Europe/Madrid")).toBe("20260829");
    expect(sinceArgument(today, "UTC")).toBe("20260828");
    expect(sinceArgument(today, "America/Los_Angeles")).toBe("20260828");
  });
});
