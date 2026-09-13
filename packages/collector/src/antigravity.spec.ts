import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  antigravityConversationsDir,
  readAntigravitySteps,
} from "./antigravity";
import { writeConversation } from "./test/antigravity-fixture";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tokenmax-antigravity-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("antigravityConversationsDir", () => {
  it("lives under the Antigravity CLI app data", () => {
    expect(antigravityConversationsDir("/home/user")).toBe(
      "/home/user/.gemini/antigravity-cli/conversations",
    );
  });
});

describe("readAntigravitySteps", () => {
  it("returns no steps when Antigravity was never installed", async () => {
    expect(await readAntigravitySteps(join(dir, "missing"))).toEqual([]);
  });

  it("reads the usage of every model step across conversations", async () => {
    const first = new Date("2026-09-12T22:30:00.000Z");
    const second = new Date("2026-09-13T12:26:50.000Z");
    writeConversation(join(dir, "a.db"), {
      generations: [[1318, "gemini-3.8-flash"]],
      steps: [null, { at: first, input: 2232, modelCode: 1318, output: 229 }],
    });
    writeConversation(join(dir, "b.db"), {
      steps: [
        null,
        {
          at: second,
          cacheRead: 8144,
          input: 9536,
          modelCode: 1318,
          output: 133,
        },
        { at: second, input: 204, modelCode: 1050, output: 4 },
      ],
    });

    expect(await readAntigravitySteps(dir)).toEqual([
      {
        at: first,
        cacheRead: 0,
        input: 2232,
        model: "gemini-3.8-flash",
        output: 229,
      },
      {
        at: second,
        cacheRead: 8144,
        input: 9536,
        model: "gemini-3.8-flash",
        output: 133,
      },
      {
        at: second,
        cacheRead: 0,
        input: 204,
        model: "gemini-unknown",
        output: 4,
      },
    ]);
  });

  it("opens a WAL conversation without sidecar files", async () => {
    const file = join(dir, "closed.db");
    writeConversation(file, {
      steps: [{ at: new Date(0), input: 1, modelCode: 1, output: 1 }],
    });
    expect(existsSync(`${file}-wal`)).toBe(false);

    expect(await readAntigravitySteps(dir)).toHaveLength(1);
    expect(existsSync(`${file}-wal`)).toBe(false);
  });

  it("sees the steps still sitting in the WAL of an open conversation", async () => {
    const file = join(dir, "open.db");
    const writer = writeConversation(
      file,
      { steps: [{ at: new Date(0), input: 1, modelCode: 1, output: 1 }] },
      true,
    );
    try {
      expect(existsSync(`${file}-wal`)).toBe(true);
      expect(await readAntigravitySteps(dir)).toHaveLength(1);
    } finally {
      writer.close();
    }
  });

  it("ignores files that are not conversations", async () => {
    writeConversation(join(dir, "a.db"), {
      steps: [{ at: new Date(0), input: 1, modelCode: 1, output: 1 }],
    });
    await writeFile(join(dir, "notes.txt"), "not a database");

    expect(await readAntigravitySteps(dir)).toHaveLength(1);
  });
});
