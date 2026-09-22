import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Fetcher } from "./http";

export interface ModelPrice {
  cacheCreate: number;
  cacheRead: number;
  input: number;
  output: number;
}

export type PriceTable = Map<string, ModelPrice>;

export interface PricedUsage {
  cacheCreate?: number;
  cacheRead: number;
  input: number;
  output: number;
}

export const litellmPricesUrl =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const maxAgeMs = 24 * 60 * 60 * 1000;
const fetchTimeoutMs = 30_000;

const pricedEntry = z.object({
  cache_creation_input_token_cost: z.number().optional(),
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
        cacheCreate: priced.data.cache_creation_input_token_cost ?? 0,
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
    usage.cacheRead * price.cacheRead +
    (usage.cacheCreate ?? 0) * price.cacheCreate
  );
}

async function readCache(
  pricesFile: string,
): Promise<{ modifiedAt: number; table: PriceTable } | null> {
  let source: string;
  let modifiedAt: number;
  try {
    [source, modifiedAt] = await Promise.all([
      readFile(pricesFile, "utf8"),
      stat(pricesFile).then((info) => info.mtimeMs),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    return { modifiedAt, table: parseLitellmPrices(source) };
  } catch {
    return null;
  }
}

async function writeCache(pricesFile: string, source: string): Promise<void> {
  await mkdir(dirname(pricesFile), { recursive: true });
  const partial = `${pricesFile}.${process.pid}.tmp`;
  await writeFile(partial, source);
  await rename(partial, pricesFile);
}

async function fetchPrices(
  fetcher: Fetcher,
  timeoutMs: number,
): Promise<string> {
  const response = await fetcher(litellmPricesUrl, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
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
  timeoutMs = fetchTimeoutMs,
): Promise<PriceTable> {
  const cached = await readCache(pricesFile);
  if (cached !== null && now.getTime() - cached.modifiedAt < maxAgeMs) {
    return cached.table;
  }
  let source: string;
  let table: PriceTable;
  try {
    source = await fetchPrices(fetcher, timeoutMs);
    table = parseLitellmPrices(source);
    if (table.size === 0) {
      throw new Error("LiteLLM returned an empty price table");
    }
  } catch (error) {
    if (cached !== null) {
      return cached.table;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not load model prices: ${message}`);
  }
  await writeCache(pricesFile, source);
  return table;
}
