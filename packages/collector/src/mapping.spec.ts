import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AntigravityStep } from "./antigravity";
import { parseCcusageDaily } from "./ccusage";
import { mapAntigravitySteps, mapCcusageDays } from "./mapping";
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
  const flash = { cacheRead: 7.5e-8, input: 7.5e-7, output: 3.75e-6 };
  const previous = { cacheRead: 0, input: 5e-7, output: 3e-6 };
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
