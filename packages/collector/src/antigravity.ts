import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AntigravityStep {
  at: Date;
  cacheRead: number;
  input: number;
  model: string;
  output: number;
}

interface ProtoField {
  number: number;
  value: bigint | Uint8Array;
}

interface RawStep {
  at: Date;
  cacheRead: number;
  input: number;
  modelCode: number;
  output: number;
}

const unknownModel = "gemini-unknown";

const usageField = 9;
const createdField = 1;
const generationField = 1;
const generationUsageField = 4;
const generationModelField = 19;
const modelCodeField = 1;
const inputField = 2;
const outputField = 3;
const cacheReadField = 5;

export function antigravityConversationsDir(home: string): string {
  return resolve(home, ".gemini", "antigravity-cli", "conversations");
}

function decodeMessage(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = bytes[offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) {
        return result;
      }
      shift += 7n;
    }
  };
  const bytesOf = (length: number): Uint8Array => {
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  };
  while (offset < bytes.length) {
    const tag = varint();
    const number = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (wireType === 0) {
      fields.push({ number, value: varint() });
    } else if (wireType === 1) {
      fields.push({ number, value: bytesOf(8) });
    } else if (wireType === 2) {
      fields.push({ number, value: bytesOf(Number(varint())) });
    } else if (wireType === 5) {
      fields.push({ number, value: bytesOf(4) });
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }
  return fields;
}

function nested(fields: ProtoField[], number: number): ProtoField[] | null {
  const field = fields.find(
    (candidate) =>
      candidate.number === number && candidate.value instanceof Uint8Array,
  );
  return field === undefined ? null : decodeMessage(field.value as Uint8Array);
}

function integer(fields: ProtoField[], number: number): number | null {
  const field = fields.find(
    (candidate) =>
      candidate.number === number && typeof candidate.value === "bigint",
  );
  return field === undefined ? null : Number(field.value);
}

function text(fields: ProtoField[], number: number): string | null {
  const field = fields.find(
    (candidate) =>
      candidate.number === number && candidate.value instanceof Uint8Array,
  );
  return field === undefined
    ? null
    : new TextDecoder().decode(field.value as Uint8Array);
}

function openReadOnly(file: string): DatabaseSync {
  const location = existsSync(`${file}-wal`)
    ? file
    : `file:${file}?immutable=1`;
  return new DatabaseSync(location, { readOnly: true });
}

function readConversation(
  file: string,
  names: Map<number, string>,
  steps: RawStep[],
): void {
  const db = openReadOnly(file);
  try {
    const generations = db.prepare("SELECT data FROM gen_metadata").all() as {
      data: Uint8Array;
    }[];
    for (const row of generations) {
      const generation = nested(decodeMessage(row.data), generationField);
      const usage =
        generation === null ? null : nested(generation, generationUsageField);
      const code = usage === null ? null : integer(usage, modelCodeField);
      const name =
        generation === null ? null : text(generation, generationModelField);
      if (code !== null && name !== null) {
        names.set(code, name);
      }
    }
    const rows = db
      .prepare("SELECT metadata FROM steps WHERE metadata IS NOT NULL")
      .all() as { metadata: Uint8Array }[];
    for (const row of rows) {
      const fields = decodeMessage(row.metadata);
      const usage = nested(fields, usageField);
      const created = nested(fields, createdField);
      const seconds = created === null ? null : integer(created, 1);
      if (usage === null || seconds === null) {
        continue;
      }
      steps.push({
        at: new Date(seconds * 1000),
        cacheRead: integer(usage, cacheReadField) ?? 0,
        input: integer(usage, inputField) ?? 0,
        modelCode: integer(usage, modelCodeField) ?? 0,
        output: integer(usage, outputField) ?? 0,
      });
    }
  } finally {
    db.close();
  }
}

export async function readAntigravitySteps(
  dir: string,
): Promise<AntigravityStep[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const names = new Map<number, string>();
  const steps: RawStep[] = [];
  for (const file of files.filter((name) => name.endsWith(".db")).sort()) {
    readConversation(resolve(dir, file), names, steps);
  }
  return steps.map(({ modelCode, ...step }) => ({
    ...step,
    model: names.get(modelCode) ?? unknownModel,
  }));
}
