import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export interface DevinStep {
  at: Date;
  cacheCreate: number;
  cacheRead: number;
  input: number;
  model: string;
  output: number;
}

export interface DevinUsage {
  failures: string[];
  steps: DevinStep[];
}

const unknownModel = "devin-unknown";

const metrics = z.object({
  cached_tokens: z.int().optional(),
  completion_tokens: z.int(),
  extra: z
    .object({ cache_creation_input_tokens: z.int().optional() })
    .optional(),
  prompt_tokens: z.int(),
});

const step = z.object({
  metrics: metrics.optional(),
  model_name: z.string().optional(),
  source: z.string(),
  timestamp: z.iso.datetime({ offset: true }),
});

const transcript = z.object({ steps: z.array(step) });

const issueText = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

export function devinTranscriptsDir(home: string): string {
  return resolve(home, ".local", "share", "devin", "cli", "transcripts");
}

function parseTranscript(source: string): DevinStep[] {
  const parsed = transcript.safeParse(JSON.parse(source));
  if (!parsed.success) {
    throw new Error(issueText(parsed.error));
  }
  const steps: DevinStep[] = [];
  for (const entry of parsed.data.steps) {
    if (entry.source !== "agent" || entry.metrics === undefined) {
      continue;
    }
    const cacheRead = entry.metrics.cached_tokens ?? 0;
    const cacheCreate = entry.metrics.extra?.cache_creation_input_tokens ?? 0;
    steps.push({
      at: new Date(entry.timestamp),
      cacheCreate,
      cacheRead,
      input: entry.metrics.prompt_tokens - cacheRead - cacheCreate,
      model: entry.model_name ?? unknownModel,
      output: entry.metrics.completion_tokens,
    });
  }
  return steps;
}

export async function readDevinSteps(dir: string): Promise<DevinUsage> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { failures: [], steps: [] };
    }
    throw error;
  }
  const steps: DevinStep[] = [];
  const failures: string[] = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const path = resolve(dir, file);
    try {
      steps.push(...parseTranscript(await readFile(path, "utf8")));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${path}: ${message}`);
    }
  }
  return { failures, steps };
}
