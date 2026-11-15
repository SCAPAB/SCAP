import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.INNEHAV_DB = ':memory:';
type Db = typeof import('./db.ts');
type Props = typeof import('./proposals.ts');
let db: Db;
let P: Props;

const F = (value: unknown, confidence: 'high' | 'medium' | 'low' = 'high') => ({ value, confidence, page: value == null ? null : 1, quote: null });
const item = (o: Record<string, unknown>) => ({
  investor_label: F(null), instrument_name: F(null), isin: F(null), date: F(null), settle_date: F(null), currency: F(null), quantity: F(null),
  price: F(null), amount: F(null), fee: F(null), commitment_total: F(null), paid_in_total: F(null), unfunded: F(null), distributed_total: F(null),
  line_items: [], note: null, ...o,
});
const extraction = (items: unknown[]) => ({ document_type: 'other', summary: 'test', issuer: F('GP'), investor_label: F('Alfa AB'), items, warnings: [] }) as never;

before(async () => {
  db = await import('./db.ts');
  P = await import('./proposals.ts');
  db.run("INSERT INTO entities (id, name, org_nr) VALUES (1, 'Alfa AB', '556000-0001'), (2, 'Beta Stiftelse', '802000-0002')");
  db.run("INSERT INTO instruments (id, type, name, isin, currency) VALUES (1, 'PE_FUND', 'Nordic Buyout Partners IV', NULL, 'SEK'), (2, 'FUND', 'Global Indexfond', 'SE0000000001', 'SEK')");
  db.run("INSERT INTO transactions (entity_id, instrument_id, type, trade_date, amount) VALUES (1, 1, 'COMMITMENT', '2024-01-01', 1000000)");
  db.run("INSERT INTO transactions (entity_id, instrument_id, type, trade_date, quantity, price, amount) VALUES (2, 2, 'BUY', '2024-01-01', 100, 10, 1000)");
});

let docSeq = 0;
function newDoc(items: unknown[]) {
  const r = db.run("INSERT INTO documents (filename, mime, sha256, size, status) VALUES ('x.pdf', 'application/pdf', ?, 1, 'review')", `sha${++docSeq}`);
  const id = Number(r.lastInsertRowid);
  P.buildProposals(id, extraction(items));
  return db.all<import('./proposals.ts').ProposalRow>('SELECT * FROM proposals WHERE document_id=? ORDER BY seq', id);
}

test('kapitalanrop: matchas på namn, avgiftsdelen bokas separat och påverkar inte NAV', () => {
  const [p] = newDoc([item({
    kind: 'CALL', instrument_name: F('Nordic Buyout Partners IV SCSp'), investor_label: F('Alfa AB'), date: F('2025-03-15'), currency: F('SEK'),
    amount: F(110_000), fee: F(10_000, 'medium'),
    line_items: [{ description: 'Investment', amount: 100_000, category: 'investment', page: 1 }, { description: 'Management fee', amount: 10_000, category: 'mgmt_fee', page: 1 }],
  })]);
  assert.equal(p.instrument_id, 1);
  assert.equal(p.entity_id, 1);
  const ev = P.evaluate(p, p.document_id);
  assert.deepEqual(ev.blocking, []);
  assert.ok(ev.checks.some((c) => c.code === 'lines_sum' && c.level === 'ok'));
  assert.ok(ev.checks.some((c) => c.code === 'over_commit' && c.level === 'ok'));
  const ref = P.approve(p.id, null, { acknowledgeWarnings: false });
  const t = db.get<{ amount: number; fee: number; document_id: number }>('SELECT amount, fee, document_id FROM transactions WHERE id=?', Number(ref.split(':')[1]))!;
  assert.equal(t.amount, 100_000);
  assert.equal(t.fee, 10_000);
  assert.equal(t.document_id, p.document_id);
  assert.equal(db.get<{ status: string }>('SELECT status FROM documents WHERE id=?', p.document_id)!.status, 'done');
});

test('samma anrop igen flaggas som möjlig dubblett och kräver bekräftelse', () => {
  const [p] = newDoc([item({ kind: 'CALL', instrument_name: F('Nordic Buyout Partners IV'), investor_label: F('Alfa AB'), date: F('2025-03-16'), currency: F('SEK'), amount: F(110_000), fee: F(10_000) })]);
  const ev = P.evaluate(p, p.document_id);
  assert.ok(ev.checks.some((c) => c.code === 'duplicate' && c.level === 'warning'));
  assert.throws(() => P.approve(p.id, null, { acknowledgeWarnings: false }), /varningarna/);
  P.reject(p.id, null, 'Dubblett');
  assert.equal(db.get<{ status: string }>('SELECT status FROM proposals WHERE id=?', p.id)!.status, 'rejected');
});

test('osäkert AI-värde spärrar godkännande tills det bekräftas', () => {
  const [p] = newDoc([item({
    kind: 'BUY', instrument_name: F('Okänd'), isin: F('SE0000000001'), investor_label: F('Beta Stiftelse, 802000-0002'),
    date: F('2025-02-03'), settle_date: F('2025-02-05', 'low'), currency: F('SEK'), quantity: F(50), price: F(12), amount: F(600),
  })]);
  assert.equal(p.instrument_id, 2, 'matchas på ISIN');
  assert.equal(p.entity_id, 2, 'matchas på org.nr');
  assert.ok(P.evaluate(p, p.document_id).blocking.some((b) => b.includes('Likviddag')));
  assert.throws(() => P.approve(p.id, null, { acknowledgeWarnings: true }), /Bekräfta/);
  const f = JSON.parse(p.fields);
  f.settle_date.confirmed = true;
  db.run('UPDATE proposals SET fields=? WHERE id=?', JSON.stringify(f), p.id);
  const ref = P.approve(p.id, null, { acknowledgeWarnings: true });
  assert.match(ref, /^transaction:/);
});

test('försäljning större än innehavet stoppas', () => {
  const [p] = newDoc([item({ kind: 'SELL', isin: F('SE0000000001'), investor_label: F('Beta Stiftelse'), date: F('2025-06-01'), currency: F('SEK'), quantity: F(1000), price: F(11), amount: F(11000) })]);
  assert.ok(P.evaluate(p, p.document_id).blocking.some((b) => b.includes('överstiger innehavet')));
});

test('innehavsbesked: avvikelse upptäcks och differensen kan föreslås som köp', () => {
  const [p] = newDoc([item({ kind: 'HOLDING', isin: F('SE0000000001'), investor_label: F('Beta Stiftelse'), date: F('2025-06-30'), currency: F('SEK'), quantity: F(175), price: F(11) })]);
  const ev = P.evaluate(p, p.document_id);
  assert.ok(ev.checks.some((c) => c.code === 'reconcile' && c.level === 'warning' && c.message.includes('25')));
  const fixId = P.proposeHoldingFix(p.id);
  const fix = db.get<import('./proposals.ts').ProposalRow>('SELECT * FROM proposals WHERE id=?', fixId)!;
  assert.equal(fix.kind, 'BUY');
  assert.equal(JSON.parse(fix.fields).quantity.value, 25);
});

test('NAV med avstämning mot kapitalkontot', () => {
  const [p] = newDoc([item({
    kind: 'NAV', instrument_name: F('Nordic Buyout Partners IV'), investor_label: F('Alfa AB'), date: F('2025-06-30'), currency: F('SEK'),
    amount: F(120_000), commitment_total: F(1_000_000), paid_in_total: F(115_000),
  })]);
  const ev = P.evaluate(p, p.document_id);
  assert.ok(ev.checks.some((c) => c.code === 'rec_Åtagande' && c.level === 'ok'));
  assert.ok(ev.checks.some((c) => c.code === 'rec_Inbetalt' && c.level === 'warning'), 'inbetalt 110 000 bokfört mot 115 000 i dokumentet');
  P.approve(p.id, null, { acknowledgeWarnings: true });
  assert.equal(db.get<{ nav: number }>('SELECT nav FROM pe_valuations WHERE entity_id=1 AND instrument_id=1')!.nav, 120_000);
});

test('namnmatchning skiljer på fondnummer', () => {
  assert.equal(P.nameScore('Nordic Buyout Partners V', 'Nordic Buyout Partners IV'), 0);
  assert.ok(P.nameScore('Nordic Buyout Partners IV SCSp', 'Nordic Buyout Partners IV') > 0.9);
});

test('namnmatchning: vehikel, andelsklass och parallella fonder hålls isär', () => {
  assert.ok(P.nameScore('Nordic Buyout Partners IV Parallel SCSp', 'Nordic Buyout Partners IV') <= 0.55);
  assert.ok(P.nameScore('European Mid-Market Fund VI (No. 2) SCSp', 'European Mid-Market Fund VI') <= 0.55);
  assert.equal(P.nameScore('Atlas Copco A', 'Atlas Copco B'), 0);
  assert.equal(P.nameScore('Alfred Berg Nordic High Yield ACC R (EUR)', 'Alfred Berg Nordic High Yield ACC R (SEK)'), 0);
  assert.ok(P.nameScore('Nordic Buyout Partners IV, L.P.', 'Nordic Buyout Partners IV') > 0.95);
});

test('osäker namnträff kräver bekräftelse och lärs in efter godkännande', () => {
  const [p] = newDoc([item({ kind: 'NAV', instrument_name: F('Nordic Buyout Prtners IV Feeder'), investor_label: F('Alfa AB'), date: F('2025-09-30'), currency: F('SEK'), amount: F(125_000) })]);
  assert.equal(p.instrument_id, null, 'feeder ska inte automatiskt kopplas till huvudfonden');
  db.run("UPDATE proposals SET instrument_id=1, match=json_set(match, '$.instrument.id', 1, '$.instrument.method', 'manual', '$.instrument.confirmed', json('true')) WHERE id=?", p.id);
  const p2 = db.get<import('./proposals.ts').ProposalRow>('SELECT * FROM proposals WHERE id=?', p.id)!;
  P.approve(p2.id, null, { acknowledgeWarnings: true });
  const [again] = newDoc([item({ kind: 'NAV', instrument_name: F('Nordic Buyout Prtners IV Feeder'), investor_label: F('Alfa AB'), date: F('2025-12-31'), currency: F('SEK'), amount: F(126_000) })]);
  assert.equal(again.instrument_id, 1);
  assert.equal(JSON.parse(again.match!).instrument.method, 'alias');
});

test('återinkallningsbar utdelning ökar outnyttjat åtagande', () => {
  const [p] = newDoc([item({
    kind: 'DISTRIBUTION', instrument_name: F('Nordic Buyout Partners IV'), investor_label: F('Alfa AB'), date: F('2025-10-15'), currency: F('SEK'), amount: F(50_000), fee: F(0),
    line_items: [{ description: 'Return of capital (recallable)', amount: 30_000, category: 'recallable', page: 1 }, { description: 'Gain', amount: 20_000, category: 'gain', page: 1 }],
  })]);
  const f = JSON.parse(p.fields);
  assert.equal(f.recallable.value, 30_000);
  const ev = P.evaluate(p, p.document_id);
  assert.ok(ev.preview.some((r) => r.label === 'Outnyttjat åtagande'));
  const ref = P.approve(p.id, null, { acknowledgeWarnings: true });
  assert.equal(db.get<{ recallable: number }>('SELECT recallable FROM transactions WHERE id=?', Number(ref.split(':')[1]))!.recallable, 30_000);
});

test('fyra ögon-principen: samma användare kan inte både granska och attestera', () => {
  db.run("INSERT INTO users (id, email, name, password_hash, role) VALUES (10,'a@x','A','x','editor'),(11,'b@x','B','x','editor')");
  db.run("INSERT INTO settings (key, value) VALUES ('dual_control','on')");
  const [p] = newDoc([item({ kind: 'NAV', instrument_name: F('Nordic Buyout Partners IV'), investor_label: F('Alfa AB'), date: F('2026-03-31'), currency: F('SEK'), amount: F(130_000) })]);
  assert.throws(() => P.approve(p.id, 10, { acknowledgeWarnings: true }), /granskad/);
  P.prepare(p.id, 10, { acknowledgeWarnings: true });
  assert.throws(() => P.approve(p.id, 10, { acknowledgeWarnings: true }), /annan användare/);
  P.approve(p.id, 11, { acknowledgeWarnings: true });
  db.run("UPDATE settings SET value='off' WHERE key='dual_control'");
});
