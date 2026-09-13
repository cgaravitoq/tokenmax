import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Fetcher } from "./http";
import {
  costOf,
  litellmPricesUrl,
  loadPrices,
  parseLitellmPrices,
} from "./pricing";

const sample = JSON.stringify({
  "gemini-3.8-flash": {
    cache_read_input_token_cost: 7.5e-8,
    input_cost_per_token: 7.5e-7,
    litellm_provider: "gemini",
    output_cost_per_token: 3.75e-6,
  },
  "gemini/gemini-3.8-flash": {
    input_cost_per_token: 7.5e-7,
    output_cost_per_token: 3.75e-6,
  },
  sample_spec: { input_cost_per_token: 0, litellm_provider: "one of..." },
  "text-embedding-3-small": { input_cost_per_token: 2e-8 },
});

const fetcherReturning = (
  status: number,
  body: string,
  calls: string[],
): Fetcher => {
  return async (url) => {
    calls.push(url);
    return { status, text: async () => body };
  };
};

const failingFetcher: Fetcher = async () => {
  throw new Error("offline");
};

let dir: string;
let pricesFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tokenmax-prices-"));
  pricesFile = join(dir, "tokenmax", "litellm-prices.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("parseLitellmPrices", () => {
  it("keeps the entries priced per input and output token", () => {
    const table = parseLitellmPrices(sample);

    expect([...table.keys()]).toEqual([
      "gemini-3.8-flash",
      "gemini/gemini-3.8-flash",
    ]);
    expect(table.get("gemini-3.8-flash")).toEqual({
      cacheRead: 7.5e-8,
      input: 7.5e-7,
      output: 3.75e-6,
    });
    expect(table.get("gemini/gemini-3.8-flash")?.cacheRead).toBe(0);
  });
});

describe("costOf", () => {
  it("prices the three token kinds", () => {
    const price = { cacheRead: 7.5e-8, input: 7.5e-7, output: 3.75e-6 };

    expect(costOf(price, { cacheRead: 8144, input: 1392, output: 133 })).toBe(
      1392 * 7.5e-7 + 133 * 3.75e-6 + 8144 * 7.5e-8,
    );
  });
});

describe("loadPrices", () => {
  it("fetches LiteLLM and writes the cache when there is none", async () => {
    const calls: string[] = [];

    const table = await loadPrices(
      fetcherReturning(200, sample, calls),
      pricesFile,
      new Date("2026-09-13T12:00:00.000Z"),
    );

    expect(calls).toEqual([litellmPricesUrl]);
    expect(table.get("gemini-3.8-flash")?.input).toBe(7.5e-7);
    expect(await readFile(pricesFile, "utf8")).toBe(sample);
  });

  it("reads a cache younger than a day without fetching", async () => {
    const calls: string[] = [];
    const now = new Date("2026-09-13T12:00:00.000Z");
    await writeCache(sample, new Date(now.getTime() - 23 * 60 * 60 * 1000));

    const table = await loadPrices(
      fetcherReturning(200, "{}", calls),
      pricesFile,
      now,
    );

    expect(calls).toEqual([]);
    expect(table.size).toBe(2);
  });

  it("refreshes a cache older than a day", async () => {
    const calls: string[] = [];
    const now = new Date("2026-09-13T12:00:00.000Z");
    await writeCache("{}", new Date(now.getTime() - 25 * 60 * 60 * 1000));

    const table = await loadPrices(
      fetcherReturning(200, sample, calls),
      pricesFile,
      now,
    );

    expect(calls).toEqual([litellmPricesUrl]);
    expect(table.size).toBe(2);
    expect(await readFile(pricesFile, "utf8")).toBe(sample);
  });

  it("keeps the stale cache when the fetch fails", async () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    await writeCache(sample, new Date(now.getTime() - 25 * 60 * 60 * 1000));

    const table = await loadPrices(failingFetcher, pricesFile, now);

    expect(table.size).toBe(2);
    expect(await readFile(pricesFile, "utf8")).toBe(sample);
  });

  it("keeps the stale cache when LiteLLM answers an error", async () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    await writeCache(sample, new Date(now.getTime() - 25 * 60 * 60 * 1000));

    const table = await loadPrices(
      fetcherReturning(503, "unavailable", []),
      pricesFile,
      now,
    );

    expect(table.size).toBe(2);
  });

  it("refetches when the cache is not a price table", async () => {
    const calls: string[] = [];
    const now = new Date("2026-09-13T12:00:00.000Z");
    await writeCache("{", new Date(now.getTime() - 60 * 1000));

    const table = await loadPrices(
      fetcherReturning(200, sample, calls),
      pricesFile,
      now,
    );

    expect(calls).toEqual([litellmPricesUrl]);
    expect(table.size).toBe(2);
    expect(await readFile(pricesFile, "utf8")).toBe(sample);
    expect(await readdir(join(dir, "tokenmax"))).toEqual([
      "litellm-prices.json",
    ]);
  });

  it("fails without a cache when the fetch fails", async () => {
    await expect(
      loadPrices(failingFetcher, pricesFile, new Date()),
    ).rejects.toThrow("could not load model prices: offline");
    await expect(readFile(pricesFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails without a cache when the body is not a price table", async () => {
    await expect(
      loadPrices(fetcherReturning(200, "[]", []), pricesFile, new Date()),
    ).rejects.toThrow("could not load model prices");
  });
});

async function writeCache(source: string, modifiedAt: Date): Promise<void> {
  await mkdir(join(dir, "tokenmax"), { recursive: true });
  await writeFile(pricesFile, source);
  await utimes(pricesFile, modifiedAt, modifiedAt);
}
