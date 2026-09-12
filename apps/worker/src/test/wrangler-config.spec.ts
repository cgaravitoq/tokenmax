import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface D1DatabaseConfig {
  binding: string;
  database_name: string;
  database_id: string;
  migrations_dir: string;
}

interface WranglerConfig {
  name: string;
  d1_databases: D1DatabaseConfig[];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const config: WranglerConfig = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    "utf8",
  ),
);

const validConfig: WranglerConfig = {
  name: "tokenmax",
  d1_databases: [
    {
      binding: "DB",
      database_name: "tokenmax",
      database_id: "11111111-2222-3333-4444-555555555555",
      migrations_dir: "./migrations",
    },
  ],
};

function bindsTokenmaxDatabase(value: WranglerConfig): boolean {
  if (value.name.length === 0) return false;
  if (value.d1_databases.length !== 1) return false;
  const database = value.d1_databases[0];
  return (
    database.binding === "DB" &&
    database.database_name.length > 0 &&
    uuid.test(database.database_id) &&
    database.migrations_dir === "./migrations"
  );
}

describe("wrangler configuration", () => {
  it("names the worker and binds exactly one D1 database", () => {
    expect(config.name.length).toBeGreaterThan(0);
    expect(config.d1_databases).toHaveLength(1);
  });

  it("binds the D1 database as DB with a migrations directory and a UUID id", () => {
    expect(bindsTokenmaxDatabase(config)).toBe(true);
  });

  it("accepts an alternate worker name and database id", () => {
    expect(
      bindsTokenmaxDatabase({
        name: "tokenmax-staging",
        d1_databases: [
          {
            ...validConfig.d1_databases[0],
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
        d1_databases: [
          validConfig.d1_databases[0],
          validConfig.d1_databases[0],
        ],
      }),
    ).toBe(false);
  });
});
