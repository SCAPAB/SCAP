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
    (4, 'EQUITY', 'Aktie Byte', 'SE0000000014', 'SEK'),
    (11, 'PE_FUND', 'Fond Överanrop', NULL, 'EUR'),
    (12, 'PE_FUND', 'Fond Utjämning', NULL, 'SEK'),
    (13, 'PE_FUND', 'Fond Sent Åtagande', NULL, 'SEK'),
    (14, 'PE_FUND', 'Fond Återinkallning', NULL, 'SEK'),
    (15, 'PE_FUND', 'Fond Integritet', NULL, 'SEK')`);
  db.run("INSERT INTO fx_rates (currency, date, rate) VALUES ('EUR', '2026-01-01', 11)");
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

// ---------------------------------------------------------------------------
// F5: kapitalanrop som överstiger outnyttjat åtagande stoppas
// ---------------------------------------------------------------------------

test('F5: anrop över outnyttjat åtagande stoppas med 400 och tydligt meddelande', () => {
  insTx({ instrument_id: 11, type: 'COMMITMENT', trade_date: '2026-01-01', amount: 300_000, fx_rate: 11 });
  insTx({ instrument_id: 11, type: 'CALL', trade_date: '2026-02-01', amount: 250_000, fx_rate: 11 });
  const msg = V.checkCommitmentTimeline(1, 11, { add: { type: 'CALL', trade_date: '2026-04-01', amount: 100_000, fee: 0 } });
  assert.equal(msg?.replace(/\u00a0/g, ' '), 'Kapitalanropet (100 000 EUR) överstiger outnyttjat åtagande (50 000 EUR) per 2026-04-01');
  assert.throws(
    () => V.validateTransaction({ entity_id: 1, instrument_id: 11, type: 'CALL', trade_date: '2026-04-01', amount: 100_000, fee: 0 }),
    (e: Error & { status?: number }) => e.status === 400 && /åtagande/.test(e.message),
  );
  // Inom toleransen 1 valutaenhet
  assert.equal(V.checkCommitmentTimeline(1, 11, { add: { type: 'CALL', trade_date: '2026-04-01', amount: 50_000.5, fee: 0 } }), null);
});

test('F5: ett anrop med utjämningsränta utanför åtagandet går igenom när dragningen ryms', () => {
  insTx({ instrument_id: 12, type: 'COMMITMENT', trade_date: '2026-01-01', amount: 100_000 });
  insTx({ instrument_id: 12, type: 'CALL', trade_date: '2026-02-01', amount: 90_000 });
  // 9 000 + avgift 2 000 = 11 000 men 1 000 är utanför åtagandet → dragning 10 000 = outnyttjat 10 000
  const v = V.validateTransaction({ entity_id: 1, instrument_id: 12, type: 'CALL', trade_date: '2026-03-01', amount: 9_000, fee: 2_000, outside_commitment: 1_000 });
  assert.equal(v.outside_commitment, 1_000);
  assert.throws(() => V.validateTransaction({ entity_id: 1, instrument_id: 12, type: 'CALL', trade_date: '2026-03-01', amount: 9_000, fee: 2_000 }), /överstiger outnyttjat åtagande \(10[\s\u00a0]000 SEK\)/);
});

test('F5: åtagande daterat efter det första anropet nämns i felmeddelandet', () => {
  insTx({ instrument_id: 13, type: 'COMMITMENT', trade_date: '2026-05-01', amount: 100_000 });
  const msg = V.checkCommitmentTimeline(1, 13, { add: { type: 'CALL', trade_date: '2026-03-01', amount: 10_000, fee: 0 } });
  assert.match(msg ?? '', /Åtagandet är registrerat först 2026-05-01/);
});

test('F5: återinkallningsbar utdelning ger utrymme, och den kan inte tas bort när ett senare anrop bygger på den', () => {
  insTx({ instrument_id: 14, type: 'COMMITMENT', trade_date: '2026-01-01', amount: 100_000 });
  insTx({ instrument_id: 14, type: 'CALL', trade_date: '2026-02-01', amount: 100_000 });
  const dist = insTx({ instrument_id: 14, type: 'DISTRIBUTION', trade_date: '2026-03-01', amount: 30_000, recallable: 20_000 });
  const v = V.validateTransaction({ entity_id: 1, instrument_id: 14, type: 'CALL', trade_date: '2026-04-01', amount: 20_000 });
  insTx({ ...v, instrument_id: 14 });
  assert.match(V.checkCommitmentTimeline(1, 14, { remove: dist }) ?? '', /överstiger outnyttjat åtagande/);
  assert.match(V.checkCommitmentTimeline(1, 14, { replace: dist, with: { type: 'DISTRIBUTION', trade_date: '2026-03-01', amount: 30_000, recallable: 0 } }) ?? '', /överstiger/);
  const commitment = db.get<{ id: number }>("SELECT id FROM transactions WHERE instrument_id=14 AND type='COMMITMENT'")!.id;
  assert.match(V.checkCommitmentTimeline(1, 14, { remove: commitment }) ?? '', /överstiger/);
});

test('F5: överanrop i äldre data syns som negativt outnyttjat och i integritetslistan', async () => {
  insTx({ instrument_id: 15, type: 'COMMITMENT', trade_date: '2026-01-01', amount: 100_000 });
  insTx({ instrument_id: 15, type: 'CALL', trade_date: '2026-02-01', amount: 150_000 });
  const issue = V.integrityIssues().find((i) => i.instrument_id === 15);
  assert.ok(issue);
  assert.equal(issue!.kind, 'commitment');
  assert.equal(issue!.date, '2026-02-01');
  const { peHolding, Market } = await import('./calc.ts');
  const ins = db.get<import('../shared/types.ts').Instrument>('SELECT * FROM instruments WHERE id=15')!;
  const h = peHolding(ins, 1, db.all('SELECT * FROM transactions WHERE instrument_id=15'), new Market({ prices: [], fx: [], valuations: [] }), '2026-06-30');
  assert.equal(h.uncalled, -50_000);
  const { exposureUncalled } = await import('./calc.ts');
  assert.equal(exposureUncalled(h), 0, 'summeringar räknar negativt outnyttjat som 0');
});
