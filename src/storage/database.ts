import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./schema.js";

export type WtfDatabase = DatabaseSync;

export function defaultDatabasePath(): string {
  return process.env.WTF_DATABASE_PATH ?? join(homedir(), ".wtf", "wtf.sqlite");
}

export function openDatabase(path = defaultDatabasePath()): WtfDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  migrateDatabase(database);
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  database.prepare("DELETE FROM runs WHERE start_time < ?").run(cutoff);
  return database;
}

export function withTransaction<T>(database: WtfDatabase, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
