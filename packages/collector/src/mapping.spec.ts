import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseCcusageDaily } from "./ccusage";
import { mapCcusageDays } from "./mapping";
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
