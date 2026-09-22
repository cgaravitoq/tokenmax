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

export interface ReaderSteps<Step> {
  failures: string[];
  steps: Step[];
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
  step_id: z.int().optional(),
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

function parseTranscript(source: string): ReaderSteps<DevinStep> {
  const parsed = transcript.safeParse(JSON.parse(source));
  if (!parsed.success) {
    throw new Error(issueText(parsed.error));
  }
  const steps: DevinStep[] = [];
  const failures: string[] = [];
  for (const entry of parsed.data.steps) {
    if (entry.source !== "agent" || entry.metrics === undefined) {
      continue;
    }
    const cacheRead = entry.metrics.cached_tokens ?? 0;
    const cacheCreate = entry.metrics.extra?.cache_creation_input_tokens ?? 0;
    const input = entry.metrics.prompt_tokens - cacheRead - cacheCreate;
    if (input < 0) {
      failures.push(
        `step ${entry.step_id ?? "?"} reports more cached than prompt tokens`,
      );
      continue;
    }
    steps.push({
      at: new Date(entry.timestamp),
      cacheCreate,
      cacheRead,
      input,
      model: entry.model_name ?? unknownModel,
      output: entry.metrics.completion_tokens,
    });
  }
  return { failures, steps };
}

export async function readDirectorySteps<Step>(
  dir: string,
  suffix: string,
  read: (file: string) => Promise<ReaderSteps<Step>>,
): Promise<ReaderSteps<Step>> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { failures: [], steps: [] };
    }
    throw error;
  }
  const steps: Step[] = [];
  const failures: string[] = [];
  for (const name of files.filter((file) => file.endsWith(suffix)).sort()) {
    const file = resolve(dir, name);
    try {
      const readFile = await read(file);
      steps.push(...readFile.steps);
      failures.push(
        ...readFile.failures.map((failure) => `${file}: ${failure}`),
      );
    } catch (error) {
      failures.push(`${file}: ${messageOf(error)}`);
    }
  }
  return { failures, steps };
}

export async function readDevinSteps(dir: string): Promise<DevinUsage> {
  return readDirectorySteps(dir, ".json", async (file) =>
    parseTranscript(await readFile(file, "utf8")),
  );
}
