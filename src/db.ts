import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
export const db = new Database(config.DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 5555,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, package_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS macros (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    steps_json TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, macro_id TEXT NOT NULL,
    phrases_json TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, device_id TEXT NOT NULL,
    macro_id TEXT NOT NULL, schedule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS execution_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, status TEXT NOT NULL,
    message TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    keys_json TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1
  );
`);

function addColumnIfMissing(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("macros", "requires_input", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing(
  "macros",
  "input_label",
  "TEXT NOT NULL DEFAULT 'O que deseja buscar?'",
);
addColumnIfMissing("macros", "input_variable", "TEXT NOT NULL DEFAULT 'texto'");

export function log(action: string, status: string, message = "") {
  db.prepare(
    "INSERT INTO execution_logs(action, status, message) VALUES (?, ?, ?)",
  ).run(action, status, message.slice(0, 1000));
}
