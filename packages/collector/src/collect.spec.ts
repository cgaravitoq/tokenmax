import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { antigravityConversationsDir } from "./antigravity";
import { sinceArgument } from "./ccusage";
import { type CollectResult, collect } from "./collect";
import { type CommandRunner, runCommand } from "./command";
import { writeConfig } from "./config";
import { devinTranscriptsDir } from "./devin";
import type { Fetcher } from "./http";
import { type CollectorPaths, collectorPaths } from "./paths";
import { litellmPricesUrl } from "./pricing";
import { writeConversation } from "./test/antigravity-fixture";
import { writeTranscript } from "./test/devin-fixture";
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
const url = "http://localhost:8797";
const target = { key, url };
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

const ccusageAntigravityDay = JSON.stringify({
  daily: [
    {
      agents: [
        {
          agent: "antigravity",
          modelBreakdowns: [
            {
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              cost: 7.5,
              inputTokens: 9_996_009,
              modelName: "gemini-3.8-flash-high",
              outputTokens: 0,
            },
          ],
        },
      ],
      period: "2026-09-09",
    },
  ],
});

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
  "claude-fable-5-1": {
    cache_creation_input_token_cost: 1.25e-5,
    cache_read_input_token_cost: 2.5e-7,
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
  },
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
      targets: [{ key, url: "http://localhost:8797/" }],
      timezone: "Europe/Madrid",
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
      kind: "reported",
      machine: "abc-123",
      targets: [{ accepted: 3, url: "http://localhost:8797/" }],
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
      machine: "abc-123",
      timezone: "Europe/Madrid",
    });
  });

  it("reports in the machine zone when the config has none", async () => {
    await writeConfig(paths.configFile, { targets: [target] });
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
      targets: [target],
      timezone: "Europe/Madrid",
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
      targets: [target],
      timezone: "Europe/Madrid",
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
      kind: "reported",
      machine: "abc-123",
      targets: [{ accepted: 4, url }],
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

  it("drops the Antigravity steps of a day ccusage already reports", async () => {
    await writeConfig(paths.configFile, {
      targets: [target],
      timezone: "UTC",
    });
    const conversations = antigravityConversationsDir(home);
    await mkdir(conversations, { recursive: true });
    writeConversation(join(conversations, "a.db"), {
      generations: [[1318, "gemini-3.8-flash"]],
      steps: [
        {
          at: new Date("2026-09-09T12:00:00.000Z"),
          input: 10_081_780,
          modelCode: 1318,
          output: 0,
        },
      ],
    });
    const requests: Request[] = [];

    const result = await collect({
      env: { home },
      fetcher: pricingFetcher(
        reportFetcher(requests, 200, '{"accepted":1}'),
        [],
      ),
      identity,
      runner: dailyRunner(ccusageAntigravityDay, []),
      today: new Date("2026-09-10T23:30:00.000Z"),
    });

    expect(result).toEqual({
      kind: "reported",
      machine: "abc-123",
      targets: [{ accepted: 1, url }],
      warnings: [],
    });
    expect(JSON.parse(String(requests[0].init.body)).days).toEqual([
      {
        cache_create: 0,
        cache_read: 0,
        cost_usd: 7.5,
        date: "2026-09-09",
        input: 9_996_009,
        model: "gemini-3.8-flash-high",
        output: 0,
        provider: "antigravity",
      },
    ]);
  });

  it("keeps the Antigravity steps of a day ccusage does not cover", async () => {
    await writeConfig(paths.configFile, {
      targets: [target],
      timezone: "UTC",
    });
    const conversations = antigravityConversationsDir(home);
    await mkdir(conversations, { recursive: true });
    writeConversation(join(conversations, "a.db"), {
      generations: [[1318, "gemini-3.8-flash"]],
      steps: [
        {
          at: new Date("2026-09-09T12:00:00.000Z"),
          input: 10_081_780,
          modelCode: 1318,
          output: 0,
        },
        {
          at: new Date("2026-09-10T12:00:00.000Z"),
          cacheRead: 8144,
          input: 9536,
          modelCode: 1318,
          output: 133,
        },
      ],
    });
    const requests: Request[] = [];

    const result = await collect({
      env: { home },
      fetcher: pricingFetcher(
        reportFetcher(requests, 200, '{"accepted":1}'),
        [],
      ),
      identity,
      runner: dailyRunner(ccusageAntigravityDay, []),
      today: new Date("2026-09-10T23:30:00.000Z"),
    });

    expect(result).toEqual({
      kind: "reported",
      machine: "abc-123",
      targets: [{ accepted: 1, url }],
      warnings: [],
    });
    expect(JSON.parse(String(requests[0].init.body)).days).toEqual([
      {
        cache_create: 0,
        cache_read: 0,
        cost_usd: 7.5,
        date: "2026-09-09",
        input: 9_996_009,
        model: "gemini-3.8-flash-high",
        output: 0,
        provider: "antigravity",
      },
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

  it("adds the Devin steps of the window as their own provider", async () => {
    await writeConfig(paths.configFile, {
      targets: [target],
      timezone: "Europe/Madrid",
    });
    const transcripts = devinTranscriptsDir(home);
    await mkdir(transcripts, { recursive: true });
    writeTranscript(join(transcripts, "abiding-hall.json"), [
      {
        at: new Date("2026-08-28T21:00:00.000Z"),
        model: "claude-fable-5-1-high",
        output: 999,
        prompt: 999,
      },
      {
        at: new Date("2026-09-09T22:30:00.000Z"),
        cacheCreate: 17366,
        cacheRead: 12510,
        model: "claude-fable-5-1-xhigh",
        output: 223,
        prompt: 29878,
      },
    ]);
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
      kind: "reported",
      machine: "abc-123",
      targets: [{ accepted: 4, url }],
      warnings: [],
    });
    expect(priceCalls).toEqual([litellmPricesUrl]);
    expect(JSON.parse(String(requests[0].init.body)).days).toEqual([
      ...expectedDays,
      {
        cache_create: 17366,
        cache_read: 12510,
        cost_usd: 2 * 1e-5 + 223 * 5e-5 + 12510 * 2.5e-7 + 17366 * 1.25e-5,
        date: "2026-09-10",
        input: 2,
        model: "claude-fable-5-1",
        output: 223,
        provider: "devin",
      },
    ]);
  });

  it("reports around a transcript it cannot read and names it", async () => {
    await writeConfig(paths.configFile, { targets: [target] });
    const transcripts = devinTranscriptsDir(home);
    await mkdir(transcripts, { recursive: true });
    await writeFile(join(transcripts, "broken.json"), "{");
    writeTranscript(join(transcripts, "ok.json"), [
      {
        at: new Date("2026-09-10T12:00:00.000Z"),
        model: "swe-2-medium",
        output: 10,
        prompt: 10,
      },
    ]);
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
      kind: "reported",
      machine: "abc-123",
      targets: [{ accepted: 4, url }],
      warnings: [
        expect.stringMatching(
          new RegExp(`^devin: skipped ${join(transcripts, "broken.json")}: `),
        ),
      ],
    });
    expect(JSON.parse(String(requests[0].init.body)).days).toHaveLength(4);
  });

  it("leaves the prices alone when no Antigravity step is in the window", async () => {
    await writeConfig(paths.configFile, { targets: [target] });
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

    expect(result).toMatchObject({
      kind: "reported",
      targets: [{ accepted: 3 }],
    });
    expect(priceCalls).toEqual([]);
    expect(JSON.parse(String(requests[0].init.body)).days).toEqual(
      expectedDays,
    );
  });

  it("still reports the ccusage days when the prices cannot be loaded", async () => {
    await writeConfig(paths.configFile, { targets: [target] });
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
      kind: "reported",
      machine: "abc-123",
      targets: [{ accepted: 3, url }],
      warnings: ["antigravity: could not load model prices: offline"],
    });
    expect(JSON.parse(String(requests[0].init.body)).days).toEqual(
      expectedDays,
    );
  });

  it("reports around a conversation it cannot read and names it", async () => {
    await writeConfig(paths.configFile, { targets: [target] });
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
      kind: "reported",
      machine: "abc-123",
      targets: [{ accepted: 4, url }],
      warnings: [
        `antigravity: skipped ${join(conversations, "broken.db")}: file is not a database`,
      ],
    });
    expect(JSON.parse(String(requests[0].init.body)).days).toHaveLength(4);
  });

  it("names the target with the status and the body when the key is rejected", async () => {
    await writeConfig(paths.configFile, { targets: [target] });
    const requests: Request[] = [];
    const result = await collect({
      env: { home },
      fetcher: reportFetcher(requests, 401, '{"error":"unauthorized"}'),
      identity,
      runner: dailyRunner(sample, []),
      today: new Date("2026-09-10T12:00:00.000Z"),
    });

    expect(result).toEqual({
      kind: "reported",
      machine: "abc-123",
      targets: [
        { message: 'tokenmax responded 401: {"error":"unauthorized"}', url },
      ],
      warnings: [],
    });
  });

  it("reports the same days to every target with its own key", async () => {
    const other = { key: "otv_other_key", url: "https://tv.example" };
    await writeConfig(paths.configFile, {
      targets: [target, other],
      timezone: "Europe/Madrid",
    });
    const requests: Request[] = [];

    const result = await collect({
      env: { home },
      fetcher: reportFetcher(requests, 200, '{"accepted":3}'),
      identity,
      runner: dailyRunner(sample, []),
      today: new Date("2026-09-10T23:30:00.000Z"),
    });

    expect(result).toEqual({
      kind: "reported",
      machine: "abc-123",
      targets: [
        { accepted: 3, url },
        { accepted: 3, url: other.url },
      ],
      warnings: [],
    });
    expect(requests.map((request) => request.url)).toEqual([
      `${url}/api/report`,
      `${other.url}/api/report`,
    ]);
    expect(requests.map((request) => request.init.headers)).toEqual([
      expect.objectContaining({ Authorization: `Bearer ${key}` }),
      expect.objectContaining({ Authorization: `Bearer ${other.key}` }),
    ]);
    expect(String(requests[0].init.body)).toBe(String(requests[1].init.body));
  });

  it("keeps reporting to the other targets when one is unreachable", async () => {
    const other = { key: "otv_other_key", url: "https://tv.example" };
    await writeConfig(paths.configFile, { targets: [target, other] });
    const requests: Request[] = [];
    const report = reportFetcher(requests, 200, '{"accepted":3}');

    const result = await collect({
      env: { home },
      fetcher: async (requestUrl, init) => {
        if (requestUrl.startsWith(url)) {
          throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:8797");
        }
        return report(requestUrl, init);
      },
      identity,
      runner: dailyRunner(sample, []),
      today: new Date("2026-09-10T23:30:00.000Z"),
    });

    expect(result).toEqual({
      kind: "reported",
      machine: "abc-123",
      targets: [
        { message: "fetch failed: ECONNREFUSED 127.0.0.1:8797", url },
        { accepted: 3, url: other.url },
      ],
      warnings: [],
    });
    expect(requests.map((request) => request.url)).toEqual([
      `${other.url}/api/report`,
    ]);
  });

  it("gives up on a target that never answers", async () => {
    await writeConfig(paths.configFile, { targets: [target] });

    const result = await collect({
      env: { home },
      fetcher: async (_url, init) => {
        const signal = init.signal;
        if (signal === undefined || signal === null) {
          throw new Error("the report fetch carries no signal");
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        });
        signal.throwIfAborted();
        throw new Error("the report fetch was not aborted");
      },
      identity,
      requestTimeoutMs: 50,
      runner: dailyRunner(sample, []),
      today: new Date("2026-09-10T23:30:00.000Z"),
    });

    expect(result).toMatchObject({
      kind: "reported",
      targets: [{ message: expect.stringMatching(/abort|timeout/i), url }],
    });
  });

  it("reports nothing without calling tokenmax when there is no usage", async () => {
    await writeConfig(paths.configFile, { targets: [target] });
    const result = await collect({
      env: { home },
      fetcher: failingFetch,
      identity,
      runner: dailyRunner('{"daily":[]}', []),
      today: new Date("2026-09-10T12:00:00.000Z"),
    });

    expect(result).toEqual({ kind: "empty", warnings: [] });
  });

  it("still reports Antigravity and Devin rows when ccusage fails", async () => {
    await writeConfig(paths.configFile, {
      targets: [target],
      timezone: "UTC",
    });
    const conversations = antigravityConversationsDir(home);
    await mkdir(conversations, { recursive: true });
    writeConversation(join(conversations, "a.db"), {
      generations: [[1318, "gemini-3.8-flash"]],
      steps: [
        {
          at: new Date("2026-09-09T12:00:00.000Z"),
          input: 10,
          modelCode: 1318,
          output: 10,
        },
      ],
    });
    const transcripts = devinTranscriptsDir(home);
    await mkdir(transcripts, { recursive: true });
    writeTranscript(join(transcripts, "abiding-hall.json"), [
      {
        at: new Date("2026-09-09T12:00:00.000Z"),
        model: "claude-fable-5-1-high",
        output: 5,
        prompt: 7,
      },
    ]);
    const requests: Request[] = [];

    const result = await collect({
      env: { home },
      fetcher: pricingFetcher(
        reportFetcher(requests, 200, '{"accepted":2}'),
        [],
      ),
      identity,
      runner: async () => ({
        exitCode: 2,
        stderr: "native binary is not available\n",
        stdout: "",
      }),
      today: new Date("2026-09-10T23:30:00.000Z"),
    });

    expect(result).toEqual({
      kind: "reported",
      machine: "abc-123",
      targets: [{ accepted: 2, url }],
      warnings: [
        "ccusage: ccusage exited with 2: native binary is not available",
      ],
    });
    expect(JSON.parse(String(requests[0].init.body)).days).toEqual([
      {
        cache_create: 0,
        cache_read: 0,
        cost_usd: 10 * 7.5e-7 + 10 * 3.75e-6,
        date: "2026-09-09",
        input: 10,
        model: "gemini-3.8-flash",
        output: 10,
        provider: "antigravity",
      },
      {
        cache_create: 0,
        cache_read: 0,
        cost_usd: 7 * 1e-5 + 5 * 5e-5,
        date: "2026-09-09",
        input: 7,
        model: "claude-fable-5-1",
        output: 5,
        provider: "devin",
      },
    ]);
  });

  it("reports a hung ccusage as a warning and keeps the local rows", async () => {
    await writeConfig(paths.configFile, {
      targets: [target],
      timezone: "UTC",
    });
    const conversations = antigravityConversationsDir(home);
    await mkdir(conversations, { recursive: true });
    writeConversation(join(conversations, "a.db"), {
      generations: [[1318, "gemini-3.8-flash"]],
      steps: [
        {
          at: new Date("2026-09-09T12:00:00.000Z"),
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
        reportFetcher(requests, 200, '{"accepted":1}'),
        [],
      ),
      identity,
      runner: (_command, _args) =>
        runCommand(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], 200),
      today: new Date("2026-09-10T23:30:00.000Z"),
    });

    expect(result).toMatchObject({
      kind: "reported",
      targets: [{ accepted: 1, url }],
      warnings: ["ccusage: ccusage exited with 1: timed out after 200ms"],
    });
    expect(JSON.parse(String(requests[0].init.body)).days).toHaveLength(1);
  });

  it("fails with the ccusage error when the command exits", async () => {
    await writeConfig(paths.configFile, { targets: [target] });
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
    await writeConfig(paths.configFile, {
      targets: [{ key, url: "http://x.test" }],
    });
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
