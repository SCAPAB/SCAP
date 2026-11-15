import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Market, listedHolding, peHolding, snapshot, valueSeries, periodReturns } from './calc.ts';
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
