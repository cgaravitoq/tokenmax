import { writeFileSync } from "node:fs";

export interface FixtureStep {
  at: Date;
  cacheCreate?: number;
  cacheRead?: number;
  model: string;
  output: number;
  prompt: number;
}

const iso = (at: Date): string =>
  `${at.toISOString().replace("Z", "000")}+00:00`;

const agentStep = (step: FixtureStep, id: number) => ({
  extra: { generation_model: step.model },
  message: "",
  metrics: {
    completion_tokens: step.output,
    prompt_tokens: step.prompt,
    ...(step.cacheRead === undefined ? {} : { cached_tokens: step.cacheRead }),
    ...(step.cacheCreate === undefined
      ? {}
      : { extra: { cache_creation_input_tokens: step.cacheCreate } }),
  },
  model_name: step.model,
  source: "agent",
  step_id: id,
  timestamp: iso(step.at),
  tool_calls: [],
});

export function writeTranscript(file: string, steps: FixtureStep[]): void {
  const first = steps[0]?.at ?? new Date(0);
  writeFileSync(
    file,
    JSON.stringify({
      agent: { model_name: "Claude Opus 5 High", name: "devin" },
      final_metrics: { total_steps: steps.length + 2 },
      schema_version: "ATIF-v1.7",
      session_id: "gigantic-raccoon",
      steps: [
        {
          message: "You are Devin",
          source: "system",
          step_id: 1,
          timestamp: iso(first),
        },
        { message: "hola", source: "user", step_id: 2, timestamp: iso(first) },
        ...steps.map((step, index) => agentStep(step, index + 3)),
      ],
    }),
  );
}
