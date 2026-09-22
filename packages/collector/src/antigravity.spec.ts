import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  antigravityConversationsDir,
  readAntigravitySteps,
} from "./antigravity";
import { schema, writeConversation } from "./test/antigravity-fixture";

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
    expect(await readAntigravitySteps(join(dir, "missing"))).toEqual({
      failures: [],
      steps: [],
    });
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

    expect((await readAntigravitySteps(dir)).steps).toEqual([
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

    expect((await readAntigravitySteps(dir)).steps).toHaveLength(1);
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
      expect((await readAntigravitySteps(dir)).steps).toHaveLength(1);
    } finally {
      writer.close();
    }
  });

  it("skips a conversation it cannot decode and keeps the others", async () => {
    writeConversation(join(dir, "a.db"), {
      steps: [{ at: new Date(0), input: 1, modelCode: 1, output: 1 }],
    });
    await writeFile(join(dir, "b.db"), "not a database");
    const truncated = new DatabaseSync(join(dir, "c.db"));
    truncated.exec(schema);
    truncated
      .prepare("INSERT INTO steps (idx, step_type, metadata) VALUES (0, 15, ?)")
      .run(Uint8Array.from([0x4a, 0x80]));
    truncated.close();

    const usage = await readAntigravitySteps(dir);

    expect(usage.steps).toHaveLength(1);
    expect(usage.failures).toEqual([
      `${join(dir, "b.db")}: file is not a database`,
      `${join(dir, "c.db")}: truncated protobuf message`,
    ]);
  });

  it("waits out a writer lock instead of dropping the conversation", async () => {
    const file = join(dir, "locked.db");
    writeConversation(file, {
      generations: [[1318, "gemini-3.8-flash"]],
      steps: [{ at: new Date(0), input: 1, modelCode: 1318, output: 1 }],
    });
    const writable = new DatabaseSync(file);
    writable.exec("PRAGMA journal_mode = delete");
    writable.close();
    await writeFile(`${file}-wal`, "");

    const script = [
      'const { DatabaseSync } = require("node:sqlite");',
      `const db = new DatabaseSync(${JSON.stringify(file)});`,
      'db.exec("BEGIN EXCLUSIVE");',
      'process.stdout.write("locked\\n");',
      'setTimeout(() => { db.exec("COMMIT"); db.close(); }, 400);',
    ].join("\n");
    const locker = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await once(locker.stdout, "data");

      const usage = await readAntigravitySteps(dir);

      expect(usage.failures).toEqual([]);
      expect(usage.steps).toHaveLength(1);
    } finally {
      await once(locker, "close");
    }
  });

  it("opens a conversation whose name needs URI escaping", async () => {
    writeConversation(join(dir, "odd name #1?.db"), {
      steps: [{ at: new Date(0), input: 1, modelCode: 1, output: 1 }],
    });

    const usage = await readAntigravitySteps(dir);

    expect(usage.steps).toHaveLength(1);
  });

  it("ignores files that are not conversations", async () => {
    writeConversation(join(dir, "a.db"), {
      steps: [{ at: new Date(0), input: 1, modelCode: 1, output: 1 }],
    });
    await writeFile(join(dir, "notes.txt"), "not a database");

    expect((await readAntigravitySteps(dir)).steps).toHaveLength(1);
  });
});
