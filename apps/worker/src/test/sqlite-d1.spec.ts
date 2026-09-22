import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1TestDatabase } from "@/test/sqlite-d1";

const databases: SqliteD1TestDatabase[] = [];

function database(): SqliteD1TestDatabase {
  const sqlite = createSqliteD1();
  databases.push(sqlite);
  return sqlite;
}

afterEach(() => {
  for (const sqlite of databases) sqlite.close();
  databases.length = 0;
});

describe("SqliteD1TestDatabase", () => {
  it("rejects a prepared statement holding more than one statement", () => {
    const db = database().asD1();

    expect(() => db.prepare("SELECT 1; SELECT 2")).toThrow(
      "D1 accepts one statement at a time",
    );
    expect(() =>
      db.prepare("CREATE TABLE t (a); INSERT INTO t VALUES (1)"),
    ).toThrow("D1 accepts one statement at a time");
  });

  it("accepts one statement with a trailing semicolon or comment", () => {
    const db = database().asD1();

    expect(() => db.prepare("SELECT 1;")).not.toThrow();
    expect(() => db.prepare("SELECT 1; -- done")).not.toThrow();
    expect(() => db.prepare("SELECT 1; /* done */")).not.toThrow();
  });

  it("rejects a statement prepared by another database", async () => {
    const statement = database().asD1().prepare("SELECT 1");

    await expect(database().asD1().batch([statement])).rejects.toThrow(
      "Statement belongs to another database",
    );
  });
});
