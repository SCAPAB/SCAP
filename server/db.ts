import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.INNEHAV_DB ?? join(here, '..', 'data', 'innehav.db');

export function openDb(path = DB_PATH): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

/** Lägger till kolumner i befintliga databaser (CREATE TABLE IF NOT EXISTS ändrar inte gamla tabeller). */
function migrate(d: DatabaseSync) {
  const cols = (t: string) => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  const tx = cols('transactions');
  if (!tx.includes('document_id')) d.exec('ALTER TABLE transactions ADD COLUMN document_id INTEGER REFERENCES documents(id)');
  if (!tx.includes('details')) d.exec('ALTER TABLE transactions ADD COLUMN details TEXT');
  const v = cols('pe_valuations');
  if (!v.includes('document_id')) d.exec('ALTER TABLE pe_valuations ADD COLUMN document_id INTEGER REFERENCES documents(id)');
}

export const db = openDb();

type Row = Record<string, unknown>;
export const all = <T = Row>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as T[];
export const get = <T = Row>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as T | undefined;
export const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[]));

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function audit(userId: number | null, action: string, object: string, objectId: unknown, details?: unknown) {
  run(
    'INSERT INTO audit_log (user_id, action, object, object_id, details) VALUES (?,?,?,?,?)',
    userId, action, object, objectId == null ? null : String(objectId), details == null ? null : JSON.stringify(details),
  );
}
