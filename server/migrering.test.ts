/**
 * Migrering av befintliga databaser (granskning 2026-11-15, F9): transaktionernas id får AUTOINCREMENT
 * så att ett id aldrig återanvänds, och ändringsbegäran får ett eget sparat förevärde.
 * Körs mot en tillfällig databasfil som byggs med den gamla tabelldefinitionen.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.INNEHAV_DB = ':memory:';
const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'innehav-migrering-'));
const path = join(tmp, 'gammal.db');
type Db = typeof import('./db.ts');
let openDb: Db['openDb'];

before(async () => {
  openDb = (await import('./db.ts')).openDb;
  // Databas med tabelldefinitionerna från före rättelsen: id utan AUTOINCREMENT och ändringsbegäran utan förevärde
  const oldSchema = readFileSync(join(here, 'schema.sql'), 'utf8')
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT,[^\n]*/, 'INTEGER PRIMARY KEY,')
    .replace(/\n\s*before_value\s+TEXT,[^\n]*/, '');
  assert.ok(!/AUTOINCREMENT|before_value/.test(oldSchema), 'den gamla definitionen ska sakna AUTOINCREMENT och before_value');
  const old = new DatabaseSync(path);
  old.exec(oldSchema);
  old.exec(`
    INSERT INTO entities (id, name) VALUES (1, 'Testenheten');
    INSERT INTO instruments (id, type, name, currency) VALUES (1, 'PE_FUND', 'Testfond Migrering I', 'SEK');
    INSERT INTO transactions (id, entity_id, instrument_id, type, trade_date, amount, fee) VALUES
      (1, 1, 1, 'COMMITMENT', '2025-01-01', 1000000, 0),
      (2, 1, 1, 'CALL', '2026-01-15', 50000, 0),
      (3, 1, 1, 'CALL', '2026-03-01', 100000, 5000);
    INSERT INTO change_requests (id, transaction_id, action, status) VALUES (1, 3, 'delete', 'approved');
    INSERT INTO audit_log (action, object, object_id, details) VALUES
      ('create', 'change_request', '1', '{"transaction_id":3,"action":"delete","before":{"id":3,"entity_id":1,"instrument_id":1,"type":"CALL","trade_date":"2026-03-01","amount":100000,"fee":5000}}'),
      ('delete', 'transaction', '3', '{}');
    DELETE FROM transactions WHERE id = 3;
  `);
  old.close();
});

after(() => rmSync(tmp, { recursive: true, force: true }));

test('F9 (granskning): en befintlig databas migreras så att ett borttaget transaktions-id aldrig återanvänds', () => {
  const d = openDb(path);
  try {
    const sql = (d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get() as { sql: string }).sql;
    assert.match(sql, /AUTOINCREMENT/);
    // Data, kolumner och index finns kvar
    const rows = d.prepare('SELECT id, type, amount, outside_commitment, recallable FROM transactions ORDER BY id').all() as { id: number; type: string; amount: number }[];
    assert.deepEqual(rows.map((r) => [r.id, r.type, r.amount]), [[1, 'COMMITMENT', 1000000], [2, 'CALL', 50000]]);
    const idx = (d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='transactions'").all() as { name: string }[]).map((r) => r.name).sort();
    assert.deepEqual(idx, ['ix_tx_entity', 'ix_tx_instr']);
    // Nästa transaktion får id 4, inte den borttagna transaktionens id 3
    const r = d.prepare("INSERT INTO transactions (entity_id, instrument_id, type, trade_date, amount) VALUES (1, 1, 'CALL', '2026-04-01', 40000)").run();
    assert.equal(Number(r.lastInsertRowid), 4);
    // Ändringsbegäran har fått sitt förevärde ur audit_log
    const cr = d.prepare('SELECT before_value FROM change_requests WHERE id = 1').get() as { before_value: string | null };
    assert.ok(cr.before_value, 'förevärdet saknas');
    const b = JSON.parse(cr.before_value);
    assert.equal(b.id, 3);
    assert.equal(b.amount, 100000);
    assert.equal(b.fee, 5000);
  } finally {
    d.close();
  }
  // Migreringen körs bara en gång: en ny öppning ändrar inget
  const again = openDb(path);
  try {
    assert.equal((again.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n, 3);
    const r = again.prepare("INSERT INTO transactions (entity_id, instrument_id, type, trade_date, amount) VALUES (1, 1, 'CALL', '2026-05-01', 1000)").run();
    assert.equal(Number(r.lastInsertRowid), 5);
  } finally {
    again.close();
  }
});
