import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

type SqliteValue = null | number | bigint | string | Uint8Array<ArrayBuffer>;

interface SqliteRow {
  [column: string]: unknown;
}

function toSqliteValue(value: unknown): SqliteValue {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(`Unsupported SQLite binding: ${typeof value}`);
}

type SqliteD1PreparedStatement = Pick<
  D1PreparedStatement,
  "all" | "first" | "run"
> & { bind(...values: unknown[]): SqliteD1PreparedStatement };

function toD1Result<T>(results: T[], changes = 0): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: results.length,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
  };
}

class SqliteD1Statement {
  readonly statement: StatementSync;

  constructor(
    private readonly owner: SqliteD1TestDatabase,
    sql: string,
    private readonly values: SqliteValue[] = [],
  ) {
    this.statement = owner.database.prepare(sql);
  }

  bind(...values: unknown[]): SqliteD1PreparedStatement {
    return new SqliteD1Statement(
      this.owner,
      this.statement.sourceSQL,
      values.map(toSqliteValue),
    );
  }

  async first<T = Record<string, unknown>>(
    columnName?: string,
  ): Promise<T | null> {
    const row = this.statement.get(...this.values) as SqliteRow | undefined;
    if (!row) return null;
    return (columnName ? row[columnName] : row) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return toD1Result(this.statement.all(...this.values) as T[]);
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.owner.beforeRun?.();
    return this.runSync() as D1Result<T>;
  }

  runSync(): D1Result {
    const result = this.statement.run(...this.values);
    return toD1Result([], Number(result.changes));
  }
}

export class SqliteD1TestDatabase {
  readonly database = new DatabaseSync(":memory:");
  beforeBatch: (() => void) | undefined;
  beforeRun: (() => void) | undefined;

  applyMigrations(names?: string[]): void {
    const directory = fileURLToPath(
      new URL("../../migrations", import.meta.url),
    );
    const migrations =
      names ??
      readdirSync(directory)
        .filter((name) => name.endsWith(".sql"))
        .sort();
    for (const migration of migrations) {
      this.database.exec(readFileSync(join(directory, migration), "utf8"));
    }
  }

  asD1(): D1Database {
    return {
      prepare: (query: string) => this.prepare(query),
      batch: <T>(statements: D1PreparedStatement[]) =>
        this.batch<T>(statements),
    } as D1Database;
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  query<T>(sql: string, ...values: SqliteValue[]): T[] {
    return this.database.prepare(sql).all(...values) as T[];
  }

  close(): void {
    this.database.close();
  }

  private prepare(query: string): SqliteD1PreparedStatement {
    return new SqliteD1Statement(this, query);
  }

  private async batch<T>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.beforeBatch?.();
    const sqliteStatements = statements.map((statement) => {
      if (!(statement instanceof SqliteD1Statement)) {
        throw new TypeError("Statement belongs to another database");
      }
      return statement;
    });
    this.database.exec("BEGIN");
    try {
      const results = sqliteStatements.map(
        (statement) => statement.runSync() as D1Result<T>,
      );
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function createSqliteD1(): SqliteD1TestDatabase {
  const database = new SqliteD1TestDatabase();
  database.applyMigrations();
  return database;
}
