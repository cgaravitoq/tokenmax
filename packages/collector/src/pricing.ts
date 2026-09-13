import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Fetcher } from "./http";

export interface ModelPrice {
  cacheRead: number;
  input: number;
  output: number;
}

export type PriceTable = Map<string, ModelPrice>;

export interface PricedUsage {
  cacheRead: number;
  input: number;
  output: number;
}

export const litellmPricesUrl =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const maxAgeMs = 24 * 60 * 60 * 1000;

const pricedEntry = z.object({
  cache_read_input_token_cost: z.number().optional(),
  input_cost_per_token: z.number(),
  output_cost_per_token: z.number(),
});

const litellmPrices = z.record(z.string(), z.unknown());

export function parseLitellmPrices(source: string): PriceTable {
  const table: PriceTable = new Map();
  for (const [model, entry] of Object.entries(
    litellmPrices.parse(JSON.parse(source)),
  )) {
    const priced = pricedEntry.safeParse(entry);
    if (priced.success) {
      table.set(model, {
        cacheRead: priced.data.cache_read_input_token_cost ?? 0,
        input: priced.data.input_cost_per_token,
        output: priced.data.output_cost_per_token,
      });
    }
  }
  return table;
}

export function costOf(price: ModelPrice, usage: PricedUsage): number {
  return (
    usage.input * price.input +
    usage.output * price.output +
    usage.cacheRead * price.cacheRead
  );
}

async function readCache(
  pricesFile: string,
): Promise<{ modifiedAt: number; source: string } | null> {
  try {
    const [source, info] = await Promise.all([
      readFile(pricesFile, "utf8"),
      stat(pricesFile),
    ]);
    return { modifiedAt: info.mtimeMs, source };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fetchPrices(fetcher: Fetcher): Promise<string> {
  const response = await fetcher(litellmPricesUrl, { method: "GET" });
  const source = await response.text();
  if (response.status !== 200) {
    throw new Error(`LiteLLM responded ${response.status}`);
  }
  return source;
}

export async function loadPrices(
  fetcher: Fetcher,
  pricesFile: string,
  now: Date,
): Promise<PriceTable> {
  const cached = await readCache(pricesFile);
  if (cached !== null && now.getTime() - cached.modifiedAt < maxAgeMs) {
    return parseLitellmPrices(cached.source);
  }
  let source: string;
  let table: PriceTable;
  try {
    source = await fetchPrices(fetcher);
    table = parseLitellmPrices(source);
  } catch (error) {
    if (cached !== null) {
      return parseLitellmPrices(cached.source);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not load model prices: ${message}`);
  }
  await mkdir(dirname(pricesFile), { recursive: true });
  await writeFile(pricesFile, source);
  return table;
}
