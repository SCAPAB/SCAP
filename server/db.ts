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
  if (!tx.includes('outside_commitment')) d.exec('ALTER TABLE transactions ADD COLUMN outside_commitment REAL NOT NULL DEFAULT 0');
  if (!tx.includes('recallable')) d.exec('ALTER TABLE transactions ADD COLUMN recallable REAL NOT NULL DEFAULT 0');
  const ins = cols('instruments');
  if (!ins.includes('asset_class')) d.exec("ALTER TABLE instruments ADD COLUMN asset_class TEXT NOT NULL DEFAULT 'PUBLIC_EQUITY'");
  if (!ins.includes('sub_class')) d.exec('ALTER TABLE instruments ADD COLUMN sub_class TEXT');
  if (!ins.includes('ms_secid')) d.exec('ALTER TABLE instruments ADD COLUMN ms_secid TEXT');
  if (!ins.includes('ms_listing')) d.exec('ALTER TABLE instruments ADD COLUMN ms_listing TEXT');
  const pr = cols('proposals');
  if (!pr.includes('prepared_by')) d.exec('ALTER TABLE proposals ADD COLUMN prepared_by INTEGER REFERENCES users(id)');
  if (!pr.includes('prepared_at')) d.exec('ALTER TABLE proposals ADD COLUMN prepared_at TEXT');
  const v = cols('pe_valuations');
  if (!v.includes('document_id')) d.exec('ALTER TABLE pe_valuations ADD COLUMN document_id INTEGER REFERENCES documents(id)');
  const cr = cols('change_requests');
  if (!cr.includes('before_value')) {
    d.exec('ALTER TABLE change_requests ADD COLUMN before_value TEXT');
    // Befintliga begäranden får förevärdet från audit_log, där det sparades när begäran skapades
    d.exec(`UPDATE change_requests SET before_value = (
      SELECT json_extract(a.details, '$.before') FROM audit_log a
      WHERE a.object = 'change_request' AND a.action = 'create' AND a.object_id = CAST(change_requests.id AS TEXT) ORDER BY a.id LIMIT 1)`);
  }
  migrateTransactionIds(d);
}

/**
 * F9: transactions.id får AUTOINCREMENT, så att ett id aldrig återanvänds efter ett borttag. Attest
 * (proposals.result_ref), ändringsbegäran (change_requests.transaction_id) och audit_log pekar på id:t,
 * och en ny transaktion får därför aldrig ärva en borttagen transaktions attest eller historik.
 * SQLite kan inte lägga till AUTOINCREMENT på en befintlig tabell, så tabellen byggs om med samma
 * kolumner, data och index. Räknaren sätts till det högsta id som någonsin har använts, också id för
 * transaktioner som redan har tagits bort.
 */
function migrateTransactionIds(d: DatabaseSync) {
  const table = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get() as { sql: string } | undefined;
  if (!table || /AUTOINCREMENT/i.test(table.sql)) return;
  const createSql = table.sql
    .replace(/^CREATE TABLE\s+("?)transactions\1/i, 'CREATE TABLE transactions_new')
    .replace(/\bid\s+INTEGER\s+PRIMARY\s+KEY\b/i, 'id INTEGER PRIMARY KEY AUTOINCREMENT');
  if (!createSql.startsWith('CREATE TABLE transactions_new') || !/AUTOINCREMENT/.test(createSql)) {
    throw new Error('Migreringen av transactions (AUTOINCREMENT) kunde inte tolka tabellens definition');
  }
  const indexes = (d.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='transactions' AND sql IS NOT NULL").all() as { sql: string }[]).map((r) => r.sql);
  d.exec('PRAGMA foreign_keys = OFF');
  try {
    d.exec('BEGIN');
    try {
      d.exec(createSql);
      d.exec('INSERT INTO transactions_new SELECT * FROM transactions');
      d.exec('DROP TABLE transactions');
      d.exec('ALTER TABLE transactions_new RENAME TO transactions');
      for (const sql of indexes) d.exec(sql);
      const hi = d.prepare(`SELECT MAX(x) m FROM (
        SELECT MAX(id) x FROM transactions
        UNION ALL SELECT MAX(CAST(substr(result_ref, 13) AS INTEGER)) FROM proposals WHERE result_ref LIKE 'transaction:%'
        UNION ALL SELECT MAX(transaction_id) FROM change_requests
        UNION ALL SELECT MAX(CAST(object_id AS INTEGER)) FROM audit_log WHERE object = 'transaction')`).get() as { m: number | null };
      d.exec("DELETE FROM sqlite_sequence WHERE name IN ('transactions', 'transactions_new')");
      if (hi.m) d.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('transactions', ?)").run(hi.m);
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  } finally {
    d.exec('PRAGMA foreign_keys = ON');
  }
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

export function setting(key: string, def: string): string {
  return get<{ value: string }>('SELECT value FROM settings WHERE key=?', key)?.value ?? def;
}
