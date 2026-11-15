/**
 * Tester mot HTTP-API:t (Express-appen med databas i minnet).
 * Täcker granskningens fynd om valutakurser, försäljning över innehav, spårbarhet och behörighet.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, client, type Client } from './testutil.ts';

type Db = typeof import('./db.ts');
let db: Db;
let admin: Client;
const PW = 'ett-langt-losenord';

before(async () => {
  await startServer();
  db = await import('./db.ts');
  const { hashPassword } = await import('./auth.ts');
  db.run("INSERT INTO entities (id, name) VALUES (1, 'Alfa AB')");
  db.run('INSERT INTO users (id, email, name, password_hash, role) VALUES (1, ?, ?, ?, ?)', 'admin@x.se', 'Admin', hashPassword(PW), 'admin');
  db.run('INSERT INTO users (id, email, name, password_hash, role) VALUES (2, ?, ?, ?, ?)', 'red@x.se', 'Redigerare', hashPassword(PW), 'editor');
  db.run("INSERT INTO instruments (id, type, name, currency) VALUES (1, 'EQUITY', 'Svensk Aktie', 'SEK'), (2, 'EQUITY', 'US Stock', 'USD'), (3, 'PE_FUND', 'Buyout IV', 'SEK')");
  admin = client();
  assert.equal(await admin.login('admin@x.se', PW), 200);
});
after(stopServer);

const buy = (o: Record<string, unknown>) => ({ entity_id: 1, instrument_id: 1, type: 'BUY', trade_date: '2025-01-10', quantity: 100, price: 1000, ...o });

// ---------------------------------------------------------------------------
// Fynd 3: försäljning får aldrig överstiga innehavet, oavsett datum
// ---------------------------------------------------------------------------

test('fynd 3: bakdaterad försäljning före en senare försäljning stoppas', async () => {
  const b = await admin.call('POST', '/transactions', buy({}));
  assert.equal(b.status, 201);
  const s1 = await admin.call('POST', '/transactions', buy({ type: 'SELL', trade_date: '2025-03-01', quantity: 80, price: 1250 }));
  assert.equal(s1.status, 201);
  // Per 2025-02-01 äger enheten 100 st, men efter försäljningen 2025-03-01 skulle innehavet bli −30
  const s2 = await admin.call('POST', '/transactions', buy({ type: 'SELL', trade_date: '2025-02-01', quantity: 50, price: 1250 }));
  assert.equal(s2.status, 400, JSON.stringify(s2.body));
  assert.match(s2.body.error, /överstiger innehavet/);
  const h = await admin.call('GET', '/instruments/1');
  assert.equal(h.body.total.quantity, 20);
  assert.equal(Math.round(h.body.total.realizedBase), 20_000);
});

test('fynd 3: köp som försäljningar bygger på kan inte tas bort eller minskas', async () => {
  const id = (await admin.call('GET', '/transactions?instrument=1')).body.find((t: { type: string }) => t.type === 'BUY').id;
  const del = await admin.call('DELETE', `/transactions/${id}`);
  assert.equal(del.status, 400, JSON.stringify(del.body));
  assert.match(del.body.error, /överstiger innehavet/);
  const upd = await admin.call('PUT', `/transactions/${id}`, buy({ quantity: 10 }));
  assert.equal(upd.status, 400);
  const later = await admin.call('PUT', `/transactions/${id}`, buy({ trade_date: '2025-04-01' }));
  assert.equal(later.status, 400, 'köpet kan inte flyttas till efter försäljningen');
  assert.equal((await admin.call('GET', '/instruments/1')).body.total.quantity, 20);
});

// ---------------------------------------------------------------------------
// Fynd 2: valutakurs från ett senare datum får aldrig användas
// ---------------------------------------------------------------------------

test('fynd 2: valutakurs hämtas högst 7 dagar bakåt och aldrig från ett senare datum', async () => {
  db.run("INSERT INTO fx_rates (currency, date, rate) VALUES ('USD', '2025-06-02', 10.5), ('USD', '2025-06-20', 11)");
  (await import('./data.ts')).bumpVersion();
  // Före första kursen: ingen kurs får hämtas från framtiden
  const early = await admin.call('POST', '/transactions', buy({ instrument_id: 2, trade_date: '2025-05-30', quantity: 10, price: 100 }));
  assert.equal(early.status, 400, JSON.stringify(early.body));
  assert.match(early.body.error, /USD/);
  // Mer än 7 dagar efter senaste kurs: måste anges manuellt
  const stale = await admin.call('POST', '/transactions', buy({ instrument_id: 2, trade_date: '2025-06-12', quantity: 10, price: 100 }));
  assert.equal(stale.status, 400);
  assert.match(stale.body.error, /manuellt/);
  // Helg/helgdag: kurs några dagar före affärsdagen godtas
  const ok = await admin.call('POST', '/transactions', buy({ instrument_id: 2, trade_date: '2025-06-08', quantity: 10, price: 100 }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const t = db.get<{ fx_rate: number }>('SELECT fx_rate FROM transactions WHERE id=?', ok.body.id)!;
  assert.equal(t.fx_rate, 10.5);
  // Manuellt angiven kurs fungerar alltid
  const manual = await admin.call('POST', '/transactions', buy({ instrument_id: 2, trade_date: '2025-05-30', quantity: 10, price: 100, fx_rate: '10,4' }));
  assert.equal(manual.status, 201);
});

// ---------------------------------------------------------------------------
// Fynd 1: saknad valutakurs ska ge tydligt fel, inte nollad avkastning
// ---------------------------------------------------------------------------

test('fynd 1: valuta utan kurs flaggas och avkastningen räknas inte som 0', async () => {
  db.run("INSERT INTO instruments (id, type, name, currency) VALUES (4, 'EQUITY', 'Japansk Aktie', 'JPY')");
  db.run("INSERT INTO transactions (entity_id, instrument_id, type, trade_date, quantity, price, amount, fx_rate) VALUES (1, 4, 'BUY', '2025-02-01', 100, 1000, 100000, 0.07)");
  db.run("INSERT INTO prices (instrument_id, date, price) VALUES (1, '2025-10-01', 1300), (4, '2025-10-01', 1100), (2, '2025-10-01', 120)");
  db.run("INSERT INTO fx_rates (currency, date, rate) VALUES ('USD', '2025-09-30', 11)");
  const { bumpVersion } = await import('./data.ts');
  bumpVersion();
  const o = await admin.call('GET', '/portfolio/overview?asOf=2025-10-01');
  assert.equal(o.status, 200);
  assert.ok(Number.isFinite(o.body.totals.marketValue), 'övriga innehav värderas');
  assert.ok(o.body.totals.marketValue > 0);
  const jpy = o.body.fxIssues.find((f: { currency: string }) => f.currency === 'JPY');
  assert.ok(jpy, 'JPY ska flaggas');
  assert.match(jpy.message, /JPY saknar valutakurs/);
  assert.deepEqual(jpy.instruments.map((i: { name: string }) => i.name), ['Japansk Aktie']);
  assert.equal(o.body.totals.unvaluedCount, 1);
  const all = o.body.returns.find((r: { key: string }) => r.key === 'ALL');
  assert.equal(all.value, null, 'ofullständig avkastning ska visas som saknad, inte 0 %');
});

// ---------------------------------------------------------------------------
// Fynd 6 och 14: kapitalanrop = totalt belopp; utjämningsränta och återinkallningsbart
// ---------------------------------------------------------------------------

test('fynd 6: kapitalanrop registreras och visas som totalt anropat belopp', async () => {
  const c = await admin.call('POST', '/transactions', { entity_id: 1, instrument_id: 3, type: 'COMMITMENT', trade_date: '2024-01-01', amount: 1_000_000 });
  assert.equal(c.status, 201);
  const r = await admin.call('POST', '/transactions', { entity_id: 1, instrument_id: 3, type: 'CALL', trade_date: '2024-03-01', amount: 110_000, fee: 10_000, outside_commitment: 2_000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const t = db.get<{ amount: number; fee: number; outside_commitment: number }>('SELECT amount, fee, outside_commitment FROM transactions WHERE id=?', r.body.id)!;
  assert.deepEqual({ ...t }, { amount: 100_000, fee: 10_000, outside_commitment: 2_000 }, 'investeringsdel + avgift lagras separat');
  const h = (await admin.call('GET', '/instruments/3?asOf=2024-06-30')).body.total;
  assert.equal(h.paidIn, 110_000, 'inbetalt = totalt anropat, ingen dubbelräkning av avgiften');
  assert.equal(h.uncalled, 1_000_000 - 108_000, 'utjämningsräntan minskar inte outnyttjat åtagande');
  const csv = (await admin.call('GET', '/reports/transactions.csv?from=2024-03-01&to=2024-03-01')).body as string;
  assert.match(csv, /Kapitalanrop;0;0;110000;10000;2000/);
  // Avgift större än totalen avvisas
  const bad = await admin.call('POST', '/transactions', { entity_id: 1, instrument_id: 3, type: 'CALL', trade_date: '2024-03-02', amount: 5_000, fee: 6_000 });
  assert.equal(bad.status, 400);
  // Redigering tar emot totalen på samma sätt
  const put = await admin.call('PUT', `/transactions/${r.body.id}`, { entity_id: 1, instrument_id: 3, type: 'CALL', trade_date: '2024-03-01', amount: 120_000, fee: 10_000, outside_commitment: 0 });
  assert.equal(put.status, 200);
  assert.equal(db.get<{ amount: number }>('SELECT amount FROM transactions WHERE id=?', r.body.id)!.amount, 110_000);
});

test('fynd 6/14: import tar emot totalbelopp, utjämningsränta och återinkallningsbart', async () => {
  const csv = 'datum;instrument;typ;belopp;avgift;utjämningsränta;återinkallningsbart\n2024-05-01;Buyout IV;Kapitalanrop;55000;5000;1000;\n2024-09-01;Buyout IV;Återbetalning;40000;;;15000';
  const r = await admin.call('POST', '/import/transactions', { csv, dryRun: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.errors, []);
  assert.equal(r.body.preview[0].belopp, 55_000);
  const call = db.get<{ amount: number; fee: number; outside_commitment: number }>("SELECT amount, fee, outside_commitment FROM transactions WHERE type='CALL' AND trade_date='2024-05-01'")!;
  assert.deepEqual({ ...call }, { amount: 50_000, fee: 5_000, outside_commitment: 1_000 });
  assert.equal(db.get<{ recallable: number }>("SELECT recallable FROM transactions WHERE type='DISTRIBUTION' AND trade_date='2024-09-01'")!.recallable, 15_000);
});
