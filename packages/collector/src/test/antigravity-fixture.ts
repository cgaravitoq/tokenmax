import { DatabaseSync } from "node:sqlite";

type ProtoValue = number | string | Uint8Array | ProtoMessage;
type ProtoMessage = [number, ProtoValue][];

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = BigInt(value);
  while (rest >= 0x80n) {
    bytes.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return bytes;
}

function encode(message: ProtoMessage): Uint8Array {
  const bytes: number[] = [];
  for (const [number, value] of message) {
    if (typeof value === "number") {
      bytes.push(...varint(number << 3), ...varint(value));
      continue;
    }
    const payload =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : encode(value);
    bytes.push(...varint((number << 3) | 2), ...varint(payload.length));
    bytes.push(...payload);
  }
  return Uint8Array.from(bytes);
}

export interface FixtureStep {
  at: Date;
  cacheRead?: number;
  input: number;
  modelCode: number;
  output: number;
}

const seconds = (at: Date): number => Math.floor(at.getTime() / 1000);

const stepMetadata = (step: FixtureStep): Uint8Array =>
  encode([
    [1, [[1, seconds(step.at)]]],
    [3, 2],
    [
      9,
      [
        [1, step.modelCode],
        [2, step.input],
        [3, step.output],
        [5, step.cacheRead ?? 0],
        [6, 24],
        [7, "bot-1"],
      ],
    ],
    [11, step.modelCode],
  ]);

const generationMetadata = (modelCode: number, name: string): Uint8Array =>
  encode([
    [
      1,
      [
        [4, [[1, modelCode]]],
        [19, name],
      ],
    ],
    [4, "conversation"],
  ]);

export const schema = `
CREATE TABLE trajectory_meta (trajectory_id text PRIMARY KEY);
CREATE TABLE steps (
  idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0,
  metadata blob, step_payload blob, PRIMARY KEY (idx)
);
CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
`;

export interface Fixture {
  generations?: [number, string][];
  steps: (FixtureStep | null)[];
}

export function writeConversation(
  file: string,
  fixture: Fixture,
  keepOpen = false,
): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(schema);
  const insertStep = db.prepare(
    "INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)",
  );
  fixture.steps.forEach((step, idx) => {
    insertStep.run(idx, step === null ? 14 : 15, step && stepMetadata(step));
  });
  const insertGeneration = db.prepare(
    "INSERT INTO gen_metadata (idx, data) VALUES (?, ?)",
  );
  (fixture.generations ?? []).forEach(([code, name], idx) => {
    insertGeneration.run(idx, generationMetadata(code, name));
  });
  if (!keepOpen) {
    db.close();
  }
  return db;
}
