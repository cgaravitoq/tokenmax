import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AntigravityStep } from "./antigravity";
import { parseCcusageDaily } from "./ccusage";
import type { DevinStep } from "./devin";
import { mapAntigravitySteps, mapCcusageDays, mapDevinSteps } from "./mapping";
import { costOf } from "./pricing";
import type { UsageDay } from "./usage";

const sample = await readFile(
  new URL("./test/ccusage-daily.json", import.meta.url),
  "utf8",
);

const expected: UsageDay[] = [
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

describe("mapCcusageDays", () => {
  it("maps a captured daily sample to the reported rows", () => {
    expect(mapCcusageDays(parseCcusageDaily(sample))).toEqual(expected);
  });

  it("sums the rows that collapse to one date, provider and model", () => {
    const collapsed = mapCcusageDays(parseCcusageDaily(sample)).find(
      (day) => day.provider === "pi",
    );
    expect(collapsed).toEqual(expected[1]);
  });

  it("drops a model breakdown whose four token counts are zero", () => {
    const models = mapCcusageDays(parseCcusageDaily(sample)).map(
      (day) => day.model,
    );
    expect(models).not.toContain("claude-sonnet-5");
  });

  it("strips the agent prefix from model names", () => {
    const models = mapCcusageDays(parseCcusageDaily(sample)).map(
      (day) => day.model,
    );
    expect(models).toContain("deepseek-v4-flash");
    expect(models.some((model) => model.startsWith("["))).toBe(false);
  });

  it("rejects a sample without daily", () => {
    expect(() => parseCcusageDaily('{"totals":{}}')).toThrow(/daily/);
  });
});

describe("mapAntigravitySteps", () => {
  const flash = {
    cacheCreate: 0,
    cacheRead: 7.5e-8,
    input: 7.5e-7,
    output: 3.75e-6,
  };
  const previous = { cacheCreate: 0, cacheRead: 0, input: 5e-7, output: 3e-6 };
  const prices = new Map([
    ["gemini-3.8-flash", flash],
    ["gemini/gemini-3.7-flash", previous],
  ]);
  const steps: AntigravityStep[] = [
    {
      at: new Date("2026-09-12T22:30:00.000Z"),
      cacheRead: 0,
      input: 2232,
      model: "gemini-3.8-flash",
      output: 229,
    },
    {
      at: new Date("2026-09-13T12:26:50.000Z"),
      cacheRead: 8144,
      input: 9536,
      model: "gemini-3.8-flash",
      output: 133,
    },
    {
      at: new Date("2026-09-13T12:27:00.000Z"),
      cacheRead: 10,
      input: 100,
      model: "gemini-3.8-flash",
      output: 20,
    },
    {
      at: new Date("2026-09-13T12:28:00.000Z"),
      cacheRead: 0,
      input: 50,
      model: "gemini-3.7-flash",
      output: 5,
    },
    {
      at: new Date("2026-09-13T12:29:00.000Z"),
      cacheRead: 0,
      input: 204,
      model: "gemini-unknown",
      output: 4,
    },
    {
      at: new Date("2026-09-13T12:30:00.000Z"),
      cacheRead: 0,
      input: 0,
      model: "gemini-3.8-flash",
      output: 0,
    },
  ];
  const flashDay: UsageDay = {
    cache_create: 0,
    cache_read: 8154,
    cost_usd: costOf(flash, { cacheRead: 8154, input: 11868, output: 382 }),
    date: "2026-09-13",
    input: 11868,
    model: "gemini-3.8-flash",
    output: 382,
    provider: "antigravity",
  };
  const previousDay: UsageDay = {
    cache_create: 0,
    cache_read: 0,
    cost_usd: costOf(previous, { cacheRead: 0, input: 50, output: 5 }),
    date: "2026-09-13",
    input: 50,
    model: "gemini-3.7-flash",
    output: 5,
    provider: "antigravity",
  };
  const unknownDay: UsageDay = {
    cache_create: 0,
    cache_read: 0,
    cost_usd: 0,
    date: "2026-09-13",
    input: 204,
    model: "gemini-unknown",
    output: 4,
    provider: "antigravity",
  };

  it("sums each model per calendar day of the timezone and prices it", () => {
    expect(mapAntigravitySteps(steps, "Europe/Madrid", prices)).toEqual([
      previousDay,
      flashDay,
      unknownDay,
    ]);
  });

  it("splits the days by the timezone it is given", () => {
    const days = mapAntigravitySteps(steps, "UTC", prices).map(
      (day) => [day.date, day.model, day.input] as const,
    );

    expect(days).toEqual([
      ["2026-09-12", "gemini-3.8-flash", 2232],
      ["2026-09-13", "gemini-3.7-flash", 50],
      ["2026-09-13", "gemini-3.8-flash", 9636],
      ["2026-09-13", "gemini-unknown", 204],
    ]);
  });
});

describe("mapDevinSteps", () => {
  const fable = {
    cacheCreate: 1.25e-5,
    cacheRead: 2.5e-7,
    input: 1e-5,
    output: 5e-5,
  };
  const sol = { cacheCreate: 5e-6, cacheRead: 4e-7, input: 4e-6, output: 2e-5 };
  const prices = new Map([
    ["claude-fable-5-1", fable],
    ["gpt-5.6-sol", sol],
  ]);
  const at = new Date("2026-09-19T16:01:31.208Z");
  const steps: DevinStep[] = [
    {
      at,
      cacheCreate: 1100211,
      cacheRead: 55834239,
      input: 772,
      model: "claude-fable-5-1-high",
      output: 245921,
    },
    {
      at,
      cacheCreate: 2552197,
      cacheRead: 64854071,
      input: 672,
      model: "claude-fable-5-1-xhigh",
      output: 270203,
    },
    {
      at,
      cacheCreate: 24494,
      cacheRead: 0,
      input: 3,
      model: "gpt-5-6-sol-high",
      output: 114,
    },
    {
      at,
      cacheCreate: 0,
      cacheRead: 0,
      input: 17615,
      model: "swe-2-medium",
      output: 48,
    },
  ];

  it("collapses the effort levels of a model into its LiteLLM name and prices it", () => {
    expect(mapDevinSteps(steps, "Europe/Madrid", prices)).toEqual([
      {
        cache_create: 3652408,
        cache_read: 120688310,
        cost_usd: costOf(fable, {
          cacheCreate: 3652408,
          cacheRead: 120688310,
          input: 1444,
          output: 516124,
        }),
        date: "2026-09-19",
        input: 1444,
        model: "claude-fable-5-1",
        output: 516124,
        provider: "devin",
      },
      {
        cache_create: 24494,
        cache_read: 0,
        cost_usd: costOf(sol, {
          cacheCreate: 24494,
          cacheRead: 0,
          input: 3,
          output: 114,
        }),
        date: "2026-09-19",
        input: 3,
        model: "gpt-5.6-sol",
        output: 114,
        provider: "devin",
      },
      {
        cache_create: 0,
        cache_read: 0,
        cost_usd: 0,
        date: "2026-09-19",
        input: 17615,
        model: "swe-2",
        output: 48,
        provider: "devin",
      },
    ]);
  });
});
