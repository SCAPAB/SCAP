/**
 * Kontroller vid registrering, ändring och borttag av transaktioner (förbättring 2026-11-15, F4 och F5).
 * Körs mot en tom databas i minnet.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.INNEHAV_DB = ':memory:';
type Db = typeof import('./db.ts');
type V = typeof import('./validate.ts');
type I = typeof import('./importer.ts');
let db: Db;
let V: V;
let I: I;

const insTx = (o: Record<string, unknown>) => {
  const t: Record<string, unknown> = { entity_id: 1, quantity: 0, price: 0, fee: 0, fx_rate: 1, outside_commitment: 0, recallable: 0, ...o };
  const r = db.run(
    'INSERT INTO transactions (entity_id, instrument_id, type, trade_date, quantity, price, amount, fee, fx_rate, outside_commitment, recallable) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    t.entity_id, t.instrument_id, t.type, t.trade_date, t.quantity, t.price, t.amount, t.fee, t.fx_rate, t.outside_commitment, t.recallable,
  );
  return Number(r.lastInsertRowid);
};

before(async () => {
  db = await import('./db.ts');
  V = await import('./validate.ts');
  I = await import('./importer.ts');
  db.run("INSERT INTO entities (id, name) VALUES (1, 'Testenheten')");
  db.run(`INSERT INTO instruments (id, type, name, isin, currency) VALUES
    (1, 'EQUITY', 'Aktie Tidslinje', 'SE0000000011', 'SEK'),
    (2, 'EQUITY', 'Aktie Import', 'SE0000000012', 'SEK'),
    (3, 'EQUITY', 'Aktie Integritet', 'SE0000000013', 'SEK'),
    (4, 'EQUITY', 'Aktie Byte', 'SE0000000014', 'SEK')`);
});

// ---------------------------------------------------------------------------
// F4: innehavet kontrolleras över hela tidslinjen
// ---------------------------------------------------------------------------

test('F4: tidslinjen – bakdaterad försäljning, rättat köp och borttaget köp stoppas', () => {
  const buy = insTx({ instrument_id: 1, type: 'BUY', trade_date: '2026-01-10', quantity: 1000, price: 100, amount: 100_000 });
  insTx({ instrument_id: 1, type: 'SELL', trade_date: '2026-03-10', quantity: 800, price: 120, amount: 96_000 });
  // Bakdaterad försäljning av 500 → 1 000 − 500 = 500 kvar när 800 säljs 2026-03-10
  const add = V.checkHoldingTimeline(1, 1, { add: { type: 'SELL', trade_date: '2026-02-10', quantity: 500 } });
  assert.match(add ?? '', /Försäljningen 2026-03-10 \(800\) överstiger innehavet \(500\) per 2026-03-10/);
  // Rättelse av köpet till 100 st
  assert.match(V.checkHoldingTimeline(1, 1, { replace: buy, with: { type: 'BUY', trade_date: '2026-01-10', quantity: 100 } }) ?? '', /överstiger innehavet \(100\)/);
  // Köpet flyttas till efter försäljningen
  assert.match(V.checkHoldingTimeline(1, 1, { replace: buy, with: { type: 'BUY', trade_date: '2026-04-10', quantity: 1000 } }) ?? '', /överstiger innehavet \(0\)/);
  // Borttag av köpet
  assert.match(V.checkHoldingTimeline(1, 1, { remove: buy }) ?? '', /överstiger/);
  // Tillåtna ändringar
  assert.equal(V.checkHoldingTimeline(1, 1, { add: { type: 'SELL', trade_date: '2026-04-01', quantity: 200 } }), null);
  assert.equal(V.checkHoldingTimeline(1, 1, { replace: buy, with: { type: 'BUY', trade_date: '2026-03-10', quantity: 800 } }), null, 'köp och försäljning samma dag: köpet räknas först');
});

test('F4: validateTransaction stoppar bakdaterad försäljning med 400', () => {
  assert.throws(
    () => V.validateTransaction({ entity_id: 1, instrument_id: 1, type: 'SELL', trade_date: '2026-02-10', quantity: 500, price: 110, amount: 55_000 }),
    (e: Error & { status?: number }) => e.status === 400 && /överstiger/.test(e.message),
  );
});

test('F4: import – två försäljningar om 500 när innehavet är 900 stoppas som i dag', () => {
  insTx({ instrument_id: 2, type: 'BUY', trade_date: '2026-01-10', quantity: 900, price: 10, amount: 9_000 });
  const csv = 'datum;instrument;typ;antal;kurs;belopp\n2026-02-01;SE0000000012;Sälj;500;11;5500\n2026-02-02;SE0000000012;Sälj;500;11;5500';
  const r = I.importCsv('transactions', csv, { dryRun: false, userId: null });
  assert.equal(r.inserted, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].row, 3);
  assert.match(r.errors[0].message, /överstiger innehavet \(400\)/);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM transactions WHERE instrument_id=2 AND type='SELL'")!.n, 0);
  // En försäljning om 500 går igenom
  const ok = I.importCsv('transactions', 'datum;instrument;typ;antal;kurs;belopp\n2026-02-01;SE0000000012;Sälj;500;11;5500', { dryRun: false, userId: null });
  assert.equal(ok.inserted, 1);
});

test('F4: integritetslistan visar ett omöjligt innehav som lagts in direkt i databasen', () => {
  insTx({ instrument_id: 3, type: 'BUY', trade_date: '2026-01-10', quantity: 100, price: 10, amount: 1_000 });
  insTx({ instrument_id: 3, type: 'SELL', trade_date: '2026-02-10', quantity: 300, price: 10, amount: 3_000 });
  const issues = V.integrityIssues();
  const hit = issues.find((i) => i.instrument_id === 3);
  assert.ok(hit, JSON.stringify(issues));
  assert.equal(hit!.kind, 'holding');
  assert.equal(hit!.date, '2026-02-10');
  assert.match(hit!.message, /överstiger innehavet \(100\)/);
  assert.ok(!issues.some((i) => i.instrument_id === 1 || i.instrument_id === 2), 'giltiga innehav listas inte');
});

test('F4: byte av instrument kontrolleras för det gamla instrumentet', () => {
  const buy = insTx({ instrument_id: 4, type: 'BUY', trade_date: '2026-01-10', quantity: 50, price: 10, amount: 500 });
  insTx({ instrument_id: 4, type: 'SELL', trade_date: '2026-02-10', quantity: 50, price: 10, amount: 500 });
  assert.match(V.checkHoldingTimeline(1, 4, { remove: buy }) ?? '', /överstiger/);
});
