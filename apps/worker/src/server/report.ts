import { z } from "zod";

export function canonicalTimezone(value: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

const calendarDate = z
  .string("invalid date")
  .regex(/^\d{4}-\d{2}-\d{2}$/, "invalid date")
  .refine(isCalendarDate, "invalid date");

const providerName = z
  .string("invalid provider")
  .min(1, "invalid provider")
  .max(64, "invalid provider");

export const usageDay = z.object(
  {
    date: calendarDate,
    provider: providerName,
    model: z
      .string("invalid model")
      .min(1, "invalid model")
      .max(128, "invalid model"),
    input: z.int("invalid input").min(0, "invalid input"),
    output: z.int("invalid output").min(0, "invalid output"),
    cache_create: z.int("invalid cache_create").min(0, "invalid cache_create"),
    cache_read: z.int("invalid cache_read").min(0, "invalid cache_read"),
    cost_usd: z.number("invalid cost_usd").min(0, "invalid cost_usd"),
  },
  "invalid report",
);

export const usageReport = z.object(
  {
    machine: z
      .string("invalid machine")
      .regex(/^[A-Za-z0-9._-]{1,64}$/, "invalid machine"),
    timezone: z
      .string("invalid timezone")
      .transform((value, ctx) => {
        const zone = canonicalTimezone(value);
        if (zone === null) {
          ctx.addIssue({ code: "custom", message: "invalid timezone" });
          return z.NEVER;
        }
        return zone;
      })
      .optional(),
    providers: z
      .array(providerName, "invalid providers")
      .max(64, "invalid providers")
      .optional(),
    days: z
      .array(usageDay, "invalid days")
      .min(1, "invalid days")
      .max(5000, "invalid days"),
  },
  "invalid report",
);

export type UsageDay = z.infer<typeof usageDay>;

export type UsageReport = z.infer<typeof usageReport>;

export type ReportParseResult =
  | { ok: true; report: UsageReport }
  | { ok: false; error: string };

export function parseReport(body: string): ReportParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, error: "invalid json" };
  }
  const report = usageReport.safeParse(payload);
  if (!report.success) {
    return { ok: false, error: report.error.issues[0].message };
  }
  return { ok: true, report: report.data };
}
