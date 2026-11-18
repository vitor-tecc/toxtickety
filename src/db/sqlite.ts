import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';

/**
 * A thin layer over Node's built-in SQLite. Using the built-in driver means there is nothing to
 * compile during install, which matters on small hosting plans.
 */
export interface Statement {
  get(...args: unknown[]): any;
  all(...args: unknown[]): any[];
  run(...args: unknown[]): { changes: number; lastInsertRowid: number };
}

export interface Transaction<T> {
  (): T;
  immediate(): T;
}

export class SqliteDatabase {
  private readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      this.statements.set(sql, statement);
    }
    const prepared = statement;
    const bind = (args: unknown[]) => args as SQLInputValue[];
    return {
      get: (...args) => prepared.get(...bind(args)),
      all: (...args) => prepared.all(...bind(args)),
      run: (...args) => {
        const result = prepared.run(...bind(args));
        return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
      },
    };
  }

  transaction<T>(action: () => T): Transaction<T> {
    const run = (begin: string): T => {
      if (this.depth > 0) return action();
      this.raw.exec(begin);
      this.depth += 1;
      try {
        const result = action();
        this.raw.exec('COMMIT');
        return result;
      } catch (error) {
        this.raw.exec('ROLLBACK');
        throw error;
      } finally {
        this.depth -= 1;
      }
    };
    const transaction = (() => run('BEGIN')) as Transaction<T>;
    transaction.immediate = () => run('BEGIN IMMEDIATE');
    return transaction;
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}
