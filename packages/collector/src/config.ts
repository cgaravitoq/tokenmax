import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const collectorTarget = z.object({
  key: z.string().min(1),
  url: z.url({ protocol: /^https?$/ }),
});

const timezone = z.string().min(1).optional();

export const collectorConfig = z.object({
  targets: z.array(collectorTarget).min(1),
  timezone,
});

const singleTargetConfig = collectorTarget
  .extend({ timezone })
  .transform(({ key, url, ...rest }) => ({ targets: [{ key, url }], ...rest }));

const storedConfig = z.union([collectorConfig, singleTargetConfig]);

export type CollectorTarget = z.infer<typeof collectorTarget>;
export type CollectorConfig = z.infer<typeof collectorConfig>;

export function canonicalTimezone(value: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function runtimeTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export type ConfigReadResult =
  | { kind: "ok"; config: CollectorConfig }
  | { kind: "missing" }
  | { kind: "invalid"; message: string };

const issueText = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
    .join("; ");

export async function readConfig(
  configFile: string,
): Promise<ConfigReadResult> {
  let source: string;
  try {
    source = await readFile(configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "invalid",
      message: `could not read tokenmax config at ${configFile}: ${message}`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "invalid",
      message: `could not parse tokenmax config at ${configFile}: ${message}`,
    };
  }

  const parsed = storedConfig.safeParse(payload);
  if (!parsed.success) {
    return {
      kind: "invalid",
      message: `invalid tokenmax config at ${configFile}: ${issueText(parsed.error)}`,
    };
  }
  return { kind: "ok", config: parsed.data };
}

export async function writeConfig(
  configFile: string,
  config: CollectorConfig,
): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
  await chmod(configFile, 0o600);
}
