import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface WranglerConfig {
  name: string;
  d1_databases: unknown[];
}

const config: WranglerConfig = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    "utf8",
  ),
);

describe("wrangler configuration", () => {
  it("binds the tokenmax D1 database as DB", () => {
    expect(config.name).toBe("tokenmax");
    expect(config.d1_databases).toHaveLength(1);
    expect(config.d1_databases[0]).toEqual({
      binding: "DB",
      database_name: "tokenmax",
      database_id: "7026a6bd-168b-411c-9ed0-1cd6601e718f",
      migrations_dir: "./migrations",
    });
  });
});
