// What `process.getBuiltinModule("node:sqlite")` returns in the tjs build: the
// slice of node:sqlite's DatabaseSync that hermes' session probe uses, on top
// of tjs:sqlite, which is synchronous too.
import { Database } from "tjs:sqlite";

class StatementSync {
  readonly #statement: ReturnType<Database["prepare"]>;

  constructor(statement: ReturnType<Database["prepare"]>) {
    this.#statement = statement;
  }

  /** The first row, or undefined when there is none, as node:sqlite returns it. */
  get(...params: unknown[]): Record<string, unknown> | undefined {
    const [row] = this.#statement.all(...params) as Record<string, unknown>[];
    return row;
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    return this.#statement.all(...params) as Record<string, unknown>[];
  }
}

export class DatabaseSync {
  readonly #db: Database;
  readonly #statements: { finalize(): void }[] = [];

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    // node:sqlite opens an existing file and never creates one when asked for
    // read-only access; tjs:sqlite creates by default.
    this.#db = new Database(path, {
      readOnly: options.readOnly ?? false,
      create: !options.readOnly,
    });
  }

  prepare(sql: string): StatementSync {
    const statement = this.#db.prepare(sql);
    this.#statements.push(statement);
    return new StatementSync(statement);
  }

  close(): void {
    for (const statement of this.#statements) statement.finalize();
    this.#statements.length = 0;
    this.#db.close();
  }
}

export default { DatabaseSync };
