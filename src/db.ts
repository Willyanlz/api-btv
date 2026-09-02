import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from './config.js';

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });

export const db = new Database(config.DATABASE_PATH);
db.pragma('journal_mode = WAL');

db.exec(
  `CREATE TABLE IF NOT EXISTS execution_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,status TEXT NOT NULL,message TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`
);

export function log(action: string, status: string, message = '') {
  db.prepare('INSERT INTO execution_logs(action,status,message) VALUES(?,?,?)').run(
    action,
    status,
    message.slice(0, 1000)
  );
}
