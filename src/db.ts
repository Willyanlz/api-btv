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
  CREATE TABLE IF NOT EXISTS device_app_cache (
    device_id TEXT NOT NULL,
    package_name TEXT NOT NULL,
    name TEXT NOT NULL,
    icon_blob BLOB,
    icon_mime_type TEXT,
    extraction_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, package_name),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
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
  CREATE TABLE IF NOT EXISTS app_screens (
    id TEXT PRIMARY KEY,
    package_name TEXT NOT NULL,
    friendly_name TEXT NOT NULL,
    activity_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(package_name, friendly_name),
    UNIQUE(package_name, activity_name)
  );
  CREATE TABLE IF NOT EXISTS app_buttons (
    id TEXT PRIMARY KEY,
    screen_id TEXT NOT NULL,
    friendly_name TEXT NOT NULL,
    resource_id TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    content_desc TEXT NOT NULL DEFAULT '',
    class_name TEXT NOT NULL DEFAULT '',
    center_x INTEGER NOT NULL DEFAULT 0,
    center_y INTEGER NOT NULL DEFAULT 0,
    bounds TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(screen_id, friendly_name),
    FOREIGN KEY (screen_id) REFERENCES app_screens(id) ON DELETE CASCADE
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

db.prepare(
  `INSERT OR IGNORE INTO app_screens
    (id, package_name, friendly_name, activity_name)
   VALUES (?, ?, ?, ?)`,
).run(
  "unitv-search",
  "com.global.unitviptv",
  "Tela de busca",
  "com.vod.ui.activity.VodSearchActivity",
);
addColumnIfMissing("macros", "input_variable", "TEXT NOT NULL DEFAULT 'texto'");
addColumnIfMissing("macros", "app_package", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing(
  "macros",
  "app_open_delay_seconds",
  "INTEGER NOT NULL DEFAULT 10",
);
addColumnIfMissing(
  "device_app_cache",
  "extraction_status",
  "TEXT NOT NULL DEFAULT 'complete'",
);

export function log(action: string, status: string, message = "") {
  db.prepare(
    "INSERT INTO execution_logs(action, status, message) VALUES (?, ?, ?)",
  ).run(action, status, message.slice(0, 1000));
}
