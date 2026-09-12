import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const config: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    "utf8",
  ),
);

const validDatabase = {
  binding: "DB",
  database_name: "tokenmax",
  database_id: "11111111-2222-3333-4444-555555555555",
  migrations_dir: "./migrations",
};

const validConfig = { name: "tokenmax", d1_databases: [validDatabase] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bindsTokenmaxDatabase(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.name !== "string" || value.name.length === 0) return false;
  if (!Array.isArray(value.d1_databases)) return false;
  if (value.d1_databases.length !== 1) return false;
  const database: unknown = value.d1_databases[0];
  if (!isRecord(database)) return false;
  return (
    database.binding === "DB" &&
    typeof database.database_name === "string" &&
    database.database_name.length > 0 &&
    typeof database.database_id === "string" &&
    uuid.test(database.database_id) &&
    database.migrations_dir === "./migrations"
  );
}

describe("wrangler configuration", () => {
  it("binds the D1 database as DB with a migrations directory and a UUID id", () => {
    expect(bindsTokenmaxDatabase(config)).toBe(true);
  });

  it("accepts an alternate worker name and database id", () => {
    expect(
      bindsTokenmaxDatabase({
        name: "tokenmax-staging",
        d1_databases: [
          {
            ...validDatabase,
            database_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects a missing or duplicate DB binding", () => {
    expect(bindsTokenmaxDatabase({ name: "tokenmax", d1_databases: [] })).toBe(
      false,
    );
    expect(
      bindsTokenmaxDatabase({
        name: "tokenmax",
        d1_databases: [validDatabase, validDatabase],
      }),
    ).toBe(false);
  });

  it("rejects a wrong binding, name, id and migrations directory", () => {
    for (const wrong of [
      { ...validDatabase, binding: "OTHER" },
      { ...validDatabase, database_name: "" },
      { ...validDatabase, database_id: "not-a-uuid" },
      { ...validDatabase, migrations_dir: "./migration" },
    ]) {
      expect(
        bindsTokenmaxDatabase({ ...validConfig, d1_databases: [wrong] }),
      ).toBe(false);
    }
    expect(bindsTokenmaxDatabase({ ...validConfig, name: "" })).toBe(false);
  });

  it("rejects non-string fields", () => {
    for (const wrong of [
      { ...validDatabase, binding: ["DB"] },
      { ...validDatabase, database_name: ["tokenmax"] },
      { ...validDatabase, database_id: [validDatabase.database_id] },
      { ...validDatabase, migrations_dir: ["./migrations"] },
      null,
      "DB",
    ]) {
      expect(
        bindsTokenmaxDatabase({ ...validConfig, d1_databases: [wrong] }),
      ).toBe(false);
    }
    expect(bindsTokenmaxDatabase({ ...validConfig, name: ["tokenmax"] })).toBe(
      false,
    );
    expect(bindsTokenmaxDatabase({ ...validConfig, d1_databases: {} })).toBe(
      false,
    );
    expect(bindsTokenmaxDatabase(null)).toBe(false);
  });
});
