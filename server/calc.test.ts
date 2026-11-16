import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Market, listedHolding, peHolding, snapshot, valueSeries, periodReturns, periodStarts, portfolioIrr } from './calc.ts';
import { xirr } from './xirr.ts';
import type { Instrument, Transaction } from '../shared/types.ts';

const ins = (p: Partial<Instrument>): Instrument => ({
  id: 1, type: 'EQUITY', name: 'X', isin: null, ticker: null, currency: 'SEK', country: null, region: null, sector: null,
  fund_category: null, manager: null, strategy: null, vintage: null, asset_class: 'PUBLIC_EQUITY', sub_class: null, ...p,
});
let nextId = 1;
const tx = (p: Partial<Transaction>): Transaction => ({
  id: nextId++, entity_id: 1, instrument_id: 1, type: 'BUY', trade_date: '2024-01-01', settle_date: null, quantity: 0, price: 0,
  amount: 0, fee: 0, fx_rate: 1, note: null, ...p,
});
const close = (a: number | null, b: number, eps = 1e-6) => assert.ok(a != null && Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('xirr: 10 % på ett år', () => {
  close(xirr([{ date: '2023-01-01', amount: -100 }, { date: '2024-01-01', amount: 110 }]), 0.1, 1e-3);
});

test('xirr: kräver flöden med båda tecknen', () => {
  assert.equal(xirr([{ date: '2023-01-01', amount: -100 }]), null);
  assert.equal(xirr([{ date: '2023-01-01', amount: 100 }, { date: '2024-01-01', amount: 100 }]), null);
});

test('genomsnittsmetoden: köp, köp, sälj ger korrekt realiserat resultat', () => {
  const m = new Market({ prices: [{ instrument_id: 1, date: '2024-06-01', price: 150 }], fx: [], valuations: [] });
  const txs = [
    tx({ type: 'BUY', quantity: 100, price: 100, amount: 10_000, fee: 0 }),
    tx({ type: 'BUY', quantity: 100, price: 120, amount: 12_000, fee: 0, trade_date: '2024-02-01' }),
    tx({ type: 'SELL', quantity: 50, price: 140, amount: 7_000, fee: 0, trade_date: '2024-03-01' }),
    tx({ type: 'DIVIDEND', amount: 300, trade_date: '2024-04-01' }),
  ];
  const h = listedHolding(ins({}), 1, txs, m, '2024-06-30');
  close(h.quantity, 150);
  close(h.avgCostLocal, 110);
  close(h.realizedBase, 7_000 - 50 * 110);
  close(h.mvBase, 150 * 150);
  close(h.unrealizedBase, 150 * 150 - 150 * 110);
  close(h.dividendsBase, 300);
  close(h.totalPnlBase, 1_500 + 6_000 + 300);
});

test('valutaeffekt separeras från kursutveckling', () => {
  const m = new Market({
    prices: [{ instrument_id: 1, date: '2024-06-01', price: 10 }],
    fx: [{ currency: 'USD', date: '2024-01-01', rate: 10 }, { currency: 'USD', date: '2024-06-01', rate: 11 }],
    valuations: [],
  });
  const h = listedHolding(ins({ currency: 'USD' }), 1, [tx({ type: 'BUY', quantity: 100, price: 10, amount: 1_000, fx_rate: 10 })], m, '2024-06-30');
  close(h.mvBase, 11_000);
  close(h.costBase, 10_000);
  close(h.unrealizedLocal, 0);
  close(h.fxEffectBase, 1_000);
});

test('PE-fond: NAV rullas fram med anrop och utdelningar efter rapportdatum', () => {
  const pe = ins({ id: 2, type: 'PE_FUND', currency: 'EUR' });
  const m = new Market({
    prices: [], fx: [{ currency: 'EUR', date: '2020-01-01', rate: 11 }],
    valuations: [{ entity_id: 1, instrument_id: 2, date: '2023-12-31', nav: 500 }],
  });
  const txs = [
    tx({ instrument_id: 2, type: 'COMMITMENT', amount: 1_000, trade_date: '2021-01-01' }),
    tx({ instrument_id: 2, type: 'CALL', amount: 400, trade_date: '2021-06-01', fx_rate: 11 }),
    tx({ instrument_id: 2, type: 'CALL', amount: 100, trade_date: '2024-02-01', fx_rate: 11 }),
    tx({ instrument_id: 2, type: 'DISTRIBUTION', amount: 50, trade_date: '2024-03-01', fx_rate: 11 }),
  ];
  const h = peHolding(pe, 1, txs, m, '2024-06-30');
  close(h.called, 500);
  close(h.uncalled, 500);
  close(h.distributed, 50);
  close(h.nav, 550);
  assert.equal(h.navEstimated, true);
  close(h.dpi, 0.1);
  close(h.tvpi, 1.2);
  close(h.navBase, 550 * 11);
  assert.ok(h.irr! > 0);
});

test('snapshot summerar över juridiska enheter och TWR påverkas inte av insättningar', () => {
  const m = new Market({
    prices: [
      { instrument_id: 1, date: '2024-01-01', price: 100 },
      { instrument_id: 1, date: '2024-01-08', price: 100 },
      { instrument_id: 1, date: '2024-01-15', price: 110 },
    ], fx: [], valuations: [],
  });
  const txs = [
    tx({ type: 'BUY', quantity: 10, price: 100, amount: 1_000, trade_date: '2024-01-01' }),
    tx({ entity_id: 2, type: 'BUY', quantity: 90, price: 100, amount: 9_000, trade_date: '2024-01-08' }),
  ];
  const data = { instruments: [ins({})], transactions: txs, market: m };
  const s = snapshot(data, '2024-01-15');
  assert.equal(s.listed.length, 1);
  close(s.listed[0].quantity, 100);
  close(s.listed[0].mvBase, 11_000);
  const series = valueSeries(data, '2024-01-01', '2024-01-15', 7);
  close(series[series.length - 1].index, 110, 1e-6);
  const pr = periodReturns(series, '2024-01-15');
  close(pr.find((p) => p.key === 'ALL')!.value, 0.1);
});

test('PE: utjämningsränta utanför åtagandet och återinkallningsbar utdelning påverkar outnyttjat korrekt', () => {
  const pe = ins({ id: 3, type: 'PE_FUND' });
  const m = new Market({ prices: [], fx: [], valuations: [] });
  const txs = [
    tx({ instrument_id: 3, type: 'COMMITMENT', amount: 1_000, trade_date: '2022-01-01' }),
    tx({ instrument_id: 3, type: 'CALL', amount: 300, fee: 20, outside_commitment: 5, trade_date: '2022-06-01' }),
    tx({ instrument_id: 3, type: 'DISTRIBUTION', amount: 100, recallable: 40, trade_date: '2023-06-01' }),
  ];
  const h = peHolding(pe, 1, txs, m, '2024-01-01');
  close(h.paidIn, 320);
  close(h.uncalled, 1_000 - 315 + 40);
  close(h.nav, 300 - 100);
});

// ---------------------------------------------------------------------------
// F1 (förbättring 2026-11-15): inflöden räknas från dagens början, utflöden vid dagens slut
// ---------------------------------------------------------------------------

test('F1: avgiften i ett stort kapitalanrop mäts mot det nya kapitalet (scenario 09)', () => {
  const fond = ins({ id: 1, type: 'FUND', asset_class: 'FIXED_INCOME' });
  const pe = ins({ id: 2, type: 'PE_FUND', asset_class: 'PRIVATE_EQUITY' });
  const m = new Market({
    prices: [{ instrument_id: 1, date: '2026-01-02', price: 100 }, { instrument_id: 1, date: '2026-06-30', price: 100 }],
    fx: [], valuations: [],
  });
  const txs = [
    tx({ instrument_id: 1, type: 'BUY', quantity: 1_000, price: 100, amount: 100_000, trade_date: '2026-01-02' }),
    tx({ instrument_id: 2, type: 'COMMITMENT', amount: 2_000_000, trade_date: '2026-01-02' }),
    tx({ instrument_id: 2, type: 'CALL', amount: 980_000, fee: 20_000, trade_date: '2026-03-02' }),
  ];
  const all = valueSeries({ instruments: [fond, pe], transactions: txs, market: m }, '2026-01-02', '2026-06-30', 7);
  // 1 080 000 / 1 100 000 − 1
  close(periodReturns(all, '2026-06-30').find((p) => p.key === 'ALL')!.value, 1_080_000 / 1_100_000 - 1, 1e-9);
  const peOnly = valueSeries({ instruments: [pe], transactions: txs.filter((t) => t.instrument_id === 2), market: m }, '2026-01-02', '2026-06-30', 7);
  close(periodReturns(peOnly, '2026-06-30').find((p) => p.key === 'ALL')!.value, -0.02, 1e-9);
});

test('F1: försäljning av hela innehavet med vinst ger +20 % (uttag räknas vid dagens slut)', () => {
  const m = new Market({ prices: [{ instrument_id: 1, date: '2024-01-01', price: 100 }, { instrument_id: 1, date: '2024-01-02', price: 100 }], fx: [], valuations: [] });
  const txs = [
    tx({ type: 'BUY', quantity: 1_000, price: 100, amount: 100_000, trade_date: '2024-01-01' }),
    tx({ type: 'SELL', quantity: 1_000, price: 120, amount: 120_000, trade_date: '2024-01-03' }),
  ];
  const s = valueSeries({ instruments: [ins({})], transactions: txs, market: m }, '2024-01-01', '2024-01-03', 1);
  close(s[s.length - 1].index, 120, 1e-9);
});

test('F1: omplacering samma dag (sälj A, köp B) nettas och blåser inte upp nämnaren', () => {
  const a = ins({ id: 1, name: 'A' });
  const b = ins({ id: 2, name: 'B' });
  const txs = [
    tx({ instrument_id: 1, type: 'BUY', quantity: 1_000, price: 100, amount: 100_000, trade_date: '2024-01-01' }),
    tx({ instrument_id: 1, type: 'SELL', quantity: 1_000, price: 100, amount: 100_000, trade_date: '2024-01-02' }),
    // Köpet registreras till kurs 100 men B stänger på 105 samma dag → V1 = 105 000 mot V0 = 100 000
    tx({ instrument_id: 2, type: 'BUY', quantity: 1_000, price: 100, amount: 100_000, trade_date: '2024-01-02' }),
  ];
  const m = new Market({
    prices: [
      { instrument_id: 1, date: '2024-01-01', price: 100 }, { instrument_id: 1, date: '2024-01-02', price: 100 },
      { instrument_id: 2, date: '2024-01-02', price: 105 },
    ], fx: [], valuations: [],
  });
  const s = valueSeries({ instruments: [a, b], transactions: txs, market: m }, '2024-01-01', '2024-01-02', 1);
  // Nettoflöde 0 → r = (V1 − V0) / V0 = (105 000 − 100 000) / 100 000 = 5 %. Med bara inflödet i nämnaren hade det blivit 5 000 / 200 000 = 2,5 %.
  close(s[s.length - 1].index, 105, 1e-9);
});

test('F1 (granskning): ett inflöde efter flera dagars kursrörelse späds inte ut', () => {
  // Granskningens fall: A köps 1 000 st à 100 den 2026-01-05 och stiger till 110 fram till 2026-01-09.
  // Den 2026-01-09 köps B för 1 000 000 med oförändrad kurs. Rätt TWR sedan start = 110 000 / 100 000 − 1 = 10 %.
  // Mäts kursrörelsen 2026-01-05 → 2026-01-08 mot V0 + F blir det 10 000 / 1 100 000 = 0,91 %.
  const a = ins({ id: 1, name: 'A' });
  const b = ins({ id: 2, name: 'B' });
  const m = new Market({
    prices: [
      { instrument_id: 1, date: '2026-01-05', price: 100 }, { instrument_id: 1, date: '2026-01-06', price: 103 },
      { instrument_id: 1, date: '2026-01-07', price: 106 }, { instrument_id: 1, date: '2026-01-08', price: 110 },
      { instrument_id: 1, date: '2026-01-09', price: 110 }, { instrument_id: 1, date: '2026-01-31', price: 110 },
      { instrument_id: 2, date: '2026-01-09', price: 100 }, { instrument_id: 2, date: '2026-01-31', price: 100 },
    ], fx: [], valuations: [],
  });
  const txs = [
    tx({ instrument_id: 1, type: 'BUY', quantity: 1_000, price: 100, amount: 100_000, trade_date: '2026-01-05' }),
    tx({ instrument_id: 2, type: 'BUY', quantity: 10_000, price: 100, amount: 1_000_000, trade_date: '2026-01-09' }),
  ];
  const s = valueSeries({ instruments: [a, b], transactions: txs, market: m }, '2026-01-05', '2026-01-31', 7);
  close(periodReturns(s, '2026-01-31').find((p) => p.key === 'ALL')!.value, 0.1, 1e-9);
});

// ---------------------------------------------------------------------------
// F2 (förbättring 2026-11-15): periodavkastning från exakt periodstart
// ---------------------------------------------------------------------------

test('F2: en NAV-rapport per 2026-06-30 ingår inte i "3 mån" per 2026-09-30', () => {
  const pe = ins({ id: 5, type: 'PE_FUND', asset_class: 'REAL_ASSETS' });
  const m = new Market({ prices: [], fx: [], valuations: [{ entity_id: 1, instrument_id: 5, date: '2026-06-30', nav: 150_000 }] });
  const txs = [
    tx({ instrument_id: 5, type: 'COMMITMENT', amount: 500_000, trade_date: '2026-01-05' }),
    tx({ instrument_id: 5, type: 'CALL', amount: 100_000, trade_date: '2026-01-05' }),
  ];
  const s = valueSeries({ instruments: [pe], transactions: txs, market: m }, '2026-01-05', '2026-09-30', 7);
  assert.ok(s.some((p) => p.date === '2026-06-30'), 'periodens startdag finns i serien');
  const pr = periodReturns(s, '2026-09-30');
  // Värdet är 150 000 både 2026-06-30 och 2026-09-30 → 3 mån = 0 %. Uppvärderingen 100 000 → 150 000 ligger i perioden före.
  close(pr.find((p) => p.key === '3M')!.value, 0, 1e-9);
  assert.equal(pr.find((p) => p.key === 'YTD')!.value, null, 'portföljen startade under året → "–"');
});

test('F2: avkastning i år mäts från 31 december även när den inte är en veckopunkt', () => {
  const m = new Market({
    prices: [
      { instrument_id: 1, date: '2025-12-01', price: 100 }, { instrument_id: 1, date: '2025-12-31', price: 120 }, { instrument_id: 1, date: '2026-06-30', price: 132 },
    ], fx: [], valuations: [],
  });
  const txs = [tx({ type: 'BUY', quantity: 100, price: 100, amount: 10_000, trade_date: '2025-12-01' })];
  const s = valueSeries({ instruments: [ins({})], transactions: txs, market: m }, '2025-12-01', '2026-06-30', 7);
  const pr = periodReturns(s, '2026-06-30');
  close(pr.find((p) => p.key === 'YTD')!.value, 0.1, 1e-9);
  close(pr.find((p) => p.key === 'ALL')!.value, 0.32, 1e-9);
});

test('F2: tom portfölj ger ingen avkastning (null i stället för 0 %)', () => {
  const m = new Market({ prices: [], fx: [], valuations: [] });
  const s = valueSeries({ instruments: [], transactions: [], market: m }, '2026-06-30', '2026-06-30', 7);
  for (const p of periodReturns(s, '2026-06-30')) assert.equal(p.value, null, p.key);
});

test('F2 (granskning): "1 mån" och "3 mån" vid månadsslut börjar på föregående månads sista dag', () => {
  const start = (asOf: string, key: string) => periodStarts(asOf).find((p) => p.key === key)!.from;
  assert.equal(start('2026-12-31', '3M'), '2026-09-30');
  assert.equal(start('2026-12-31', '1M'), '2026-11-30');
  assert.equal(start('2026-03-31', '1M'), '2026-02-28');
  assert.equal(start('2026-03-31', '3M'), '2025-12-31');
  assert.equal(start('2028-03-31', '1M'), '2028-02-29');
  assert.equal(start('2028-02-29', '1Y'), '2027-02-28');
  // Mitt i månaden är det oförändrat samma dag
  assert.equal(start('2026-09-30', '3M'), '2026-06-30');
  assert.equal(start('2026-05-15', '1M'), '2026-04-15');
  assert.equal(start('2026-05-15', '3Y'), '2023-05-15');
});

// ---------------------------------------------------------------------------
// F3 (förbättring 2026-11-15): valutakurs från ett senare datum används aldrig
// ---------------------------------------------------------------------------

test('F3: fxRate före första registrerade kurs är NaN (ingen framtida kurs)', () => {
  const m = new Market({ prices: [], fx: [{ currency: 'USD', date: '2025-10-01', rate: 10.5 }], valuations: [] });
  assert.ok(Number.isNaN(m.fxRate('USD', '2025-01-15')));
  assert.equal(m.fxAsOf('USD', '2025-01-15'), null);
  assert.deepEqual(m.fxAsOf('USD', '2025-11-01'), { date: '2025-10-01', value: 10.5 });
  assert.equal(m.fxRate('SEK', '2025-01-15'), 1);
});

test('F3: utan registrerad kurs värderas innehavet med kursen från den senaste egna affären', () => {
  const usd = ins({ id: 7, currency: 'USD' });
  const m = new Market({ prices: [{ instrument_id: 7, date: '2026-06-30', price: 110 }], fx: [], valuations: [] });
  const h = listedHolding(usd, 1, [tx({ instrument_id: 7, type: 'BUY', quantity: 10, price: 100, amount: 1_000, fx_rate: 10, trade_date: '2026-01-10' })], m, '2026-06-30');
  close(h.fx, 10);
  close(h.mvBase, 11_000);
  assert.equal(h.fxSource, 'transaction');
  assert.equal(h.fxDate, '2026-01-10');
  const m2 = new Market({ prices: [{ instrument_id: 7, date: '2026-06-30', price: 110 }], fx: [{ currency: 'USD', date: '2026-06-29', rate: 10.2 }], valuations: [] });
  const h2 = listedHolding(usd, 1, [tx({ instrument_id: 7, type: 'BUY', quantity: 10, price: 100, amount: 1_000, fx_rate: 10, trade_date: '2026-01-10' })], m2, '2026-06-30');
  close(h2.fx, 10.2);
  assert.equal(h2.fxSource, 'register');
  assert.equal(h2.fxDate, '2026-06-29');
});

// ---------------------------------------------------------------------------
// F6 (förbättring 2026-11-15): kostnader utanför NAV i slutna fonder
// ---------------------------------------------------------------------------

test('F6: avgifter utanför NAV = avgifter i anrop + avgiftstransaktioner, inbetalt oförändrat', () => {
  const pe = ins({ id: 8, type: 'PE_FUND', asset_class: 'PRIVATE_EQUITY' });
  const m = new Market({ prices: [], fx: [], valuations: [] });
  const txs = [
    tx({ instrument_id: 8, type: 'COMMITMENT', amount: 1_000_000, trade_date: '2025-01-01' }),
    tx({ instrument_id: 8, type: 'CALL', amount: 280_000, fee: 20_000, trade_date: '2025-03-01' }),
    tx({ instrument_id: 8, type: 'CALL', amount: 100_000, fee: 15_000, trade_date: '2026-03-01' }),
    tx({ instrument_id: 8, type: 'FEE', amount: 5_000, trade_date: '2026-04-01' }),
  ];
  const h = peHolding(pe, 1, txs, m, '2026-06-30');
  close(h.fees, 40_000);
  close(h.paidIn, 420_000);
  close(h.uncalled, 585_000);
  close(h.nav, 380_000);
});

test('F6: utdelning med källskatt minskar framräknat NAV med bruttobeloppet', () => {
  const pe = ins({ id: 9, type: 'PE_FUND', asset_class: 'PRIVATE_EQUITY' });
  const m = new Market({ prices: [], fx: [], valuations: [{ entity_id: 1, instrument_id: 9, date: '2026-03-31', nav: 500_000 }] });
  const txs = [
    tx({ instrument_id: 9, type: 'COMMITMENT', amount: 1_000_000, trade_date: '2025-01-01' }),
    tx({ instrument_id: 9, type: 'CALL', amount: 450_000, trade_date: '2025-03-01' }),
    tx({ instrument_id: 9, type: 'DISTRIBUTION', amount: 100_000, fee: 10_000, trade_date: '2026-05-01' }),
  ];
  const h = peHolding(pe, 1, txs, m, '2026-06-30');
  close(h.nav, 400_000);
  close(h.distributed, 90_000);
});

// ---------------------------------------------------------------------------
// F7 (förbättring 2026-11-15): IRR för hela portföljen
// ---------------------------------------------------------------------------

test('F7: IRR för hela portföljen över alla kassaflöden, och ett aviserat anrop efter asOf påverkar inte', () => {
  const txs = [
    tx({ instrument_id: 1, type: 'BUY', quantity: 1_000, price: 100, amount: 100_000, trade_date: '2025-06-30' }),
    tx({ instrument_id: 2, type: 'COMMITMENT', amount: 500_000, trade_date: '2025-06-30' }),
    tx({ instrument_id: 2, type: 'CALL', amount: 100_000, trade_date: '2025-06-30' }),
  ];
  // 200 000 in, 250 000 värde efter exakt 365 dagar → 25 %
  close(portfolioIrr(txs, 250_000, '2026-06-30'), 0.25, 1e-6);
  const withFuture = [...txs, tx({ instrument_id: 2, type: 'CALL', amount: 50_000, trade_date: '2026-09-15' })];
  close(portfolioIrr(withFuture, 250_000, '2026-06-30'), 0.25, 1e-6);
});
