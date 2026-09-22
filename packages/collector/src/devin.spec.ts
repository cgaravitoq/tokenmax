import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devinTranscriptsDir, readDevinSteps } from "./devin";
import { writeTranscript } from "./test/devin-fixture";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tokenmax-devin-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("devinTranscriptsDir", () => {
  it("lives under the Devin CLI app data", () => {
    expect(devinTranscriptsDir("/home/user")).toBe(
      "/home/user/.local/share/devin/cli/transcripts",
    );
  });
});

describe("readDevinSteps", () => {
  it("returns no steps when Devin was never installed", async () => {
    expect(await readDevinSteps(join(dir, "missing"))).toEqual({
      failures: [],
      steps: [],
    });
  });

  it("reads the usage of every agent step across transcripts", async () => {
    const first = new Date("2026-09-21T12:54:17.676Z");
    const second = new Date("2026-09-19T16:01:31.208Z");
    writeTranscript(join(dir, "gigantic-raccoon.json"), [
      {
        at: first,
        cacheCreate: 17366,
        cacheRead: 12510,
        model: "claude-opus-5-high",
        output: 223,
        prompt: 29878,
      },
    ]);
    writeTranscript(join(dir, "abiding-hall.json"), [
      {
        at: second,
        cacheCreate: 24494,
        model: "gpt-5-6-sol-high",
        output: 114,
        prompt: 24497,
      },
      { at: second, model: "swe-2-medium", output: 48, prompt: 17615 },
    ]);

    expect((await readDevinSteps(dir)).steps).toEqual([
      {
        at: second,
        cacheCreate: 24494,
        cacheRead: 0,
        input: 3,
        model: "gpt-5-6-sol-high",
        output: 114,
      },
      {
        at: second,
        cacheCreate: 0,
        cacheRead: 0,
        input: 17615,
        model: "swe-2-medium",
        output: 48,
      },
      {
        at: first,
        cacheCreate: 17366,
        cacheRead: 12510,
        input: 2,
        model: "claude-opus-5-high",
        output: 223,
      },
    ]);
  });

  it("skips a step that reports more cached than prompt tokens", async () => {
    writeTranscript(join(dir, "a.json"), [
      {
        at: new Date(0),
        cacheCreate: 2000,
        cacheRead: 5000,
        model: "claude-opus-5-high",
        output: 7,
        prompt: 1000,
      },
      { at: new Date(0), model: "swe-2-medium", output: 1, prompt: 1 },
    ]);

    const usage = await readDevinSteps(dir);

    expect(usage.steps).toEqual([
      {
        at: new Date(0),
        cacheCreate: 0,
        cacheRead: 0,
        input: 1,
        model: "swe-2-medium",
        output: 1,
      },
    ]);
    expect(usage.failures).toEqual([
      `${join(dir, "a.json")}: step 3 reports more cached than prompt tokens`,
    ]);
  });

  it("keeps a transcript whose step ids are not integers", async () => {
    const file = join(dir, "a.json");
    writeTranscript(file, [
      { at: new Date(0), model: "swe-2-medium", output: 1, prompt: 1 },
      {
        at: new Date(0),
        cacheRead: 5000,
        model: "swe-2-medium",
        output: 1,
        prompt: 1000,
      },
    ]);
    const transcript = JSON.parse(await readFile(file, "utf8"));
    transcript.steps[2].step_id = "3";
    transcript.steps[3].step_id = 3.5;
    await writeFile(file, JSON.stringify(transcript));

    const usage = await readDevinSteps(dir);

    expect(usage.steps).toEqual([
      {
        at: new Date(0),
        cacheCreate: 0,
        cacheRead: 0,
        input: 1,
        model: "swe-2-medium",
        output: 1,
      },
    ]);
    expect(usage.failures).toEqual([
      `${file}: step 3.5 reports more cached than prompt tokens`,
    ]);
  });

  it("skips a transcript it cannot decode and keeps the others", async () => {
    writeTranscript(join(dir, "a.json"), [
      { at: new Date(0), model: "swe-2-medium", output: 1, prompt: 1 },
    ]);
    await writeFile(join(dir, "b.json"), "{");
    await writeFile(join(dir, "c.json"), '{"steps":[{"source":"agent"}]}');

    const usage = await readDevinSteps(dir);

    expect(usage.steps).toHaveLength(1);
    expect(usage.failures).toEqual([
      expect.stringMatching(/\/b\.json: .*JSON/),
      `${join(dir, "c.json")}: steps.0.timestamp: Invalid input: expected string, received undefined`,
    ]);
  });

  it("ignores files that are not transcripts", async () => {
    writeTranscript(join(dir, "a.json"), [
      { at: new Date(0), model: "swe-2-medium", output: 1, prompt: 1 },
    ]);
    await writeFile(join(dir, "notes.txt"), "{");

    expect(await readDevinSteps(dir)).toMatchObject({
      failures: [],
      steps: [{ model: "swe-2-medium" }],
    });
  });
});
