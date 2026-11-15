import { Router, type Request } from 'express';
import { all, get, run, tx, audit } from './db.ts';
import { HttpError, authenticate, hashPassword, login, logout, requireRole } from './auth.ts';
import {
  bumpVersion, cached, entities, getMarket, instruments, parseDate, parseEntities, portfolioData, today,
} from './data.ts';
import { allocate, peHolding, listedHolding, periodReturns, snapshot, valueSeries, addDays, sumListed, sumPe, stripPe, portfolioIrrBase } from './calc.ts';
import { validateInstrument, validateTransaction, isDate, num } from './validate.ts';
import { importCsv, IMPORT_KINDS } from './importer.ts';
import { toCsv } from './csv.ts';
import { docs } from './documents.ts';
import { portfolioRoutes } from './portfolio.ts';
import type { Instrument, Transaction, ListedHolding, PeHolding, InstrumentType } from '../shared/types.ts';
import { TX_LABELS, TYPE_LABELS, ASSET_CLASS_LABEL, type AssetClass } from '../shared/types.ts';

export const api = Router();

api.post('/auth/login', login);
api.post('/auth/logout', logout);
api.use(authenticate);
api.get('/auth/me', (req, res) => res.json(req.user));
api.use(docs);
api.use(portfolioRoutes);

const uid = (req: Request) => req.user?.id ?? null;
const editor = requireRole('editor');
const admin = requireRole('admin');

// ---------------------------------------------------------------------------
// Grunddata
// ---------------------------------------------------------------------------

api.get('/entities', (_req, res) => res.json(entities()));
api.post('/entities', admin, (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Namn krävs');
  const r = run('INSERT INTO entities (name, org_nr) VALUES (?,?)', name, req.body?.org_nr || null);
  audit(uid(req), 'create', 'entity', r.lastInsertRowid, req.body);
  bumpVersion();
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
api.put('/entities/:id', admin, (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Namn krävs');
  run('UPDATE entities SET name=?, org_nr=? WHERE id=?', name, req.body?.org_nr || null, Number(req.params.id));
  audit(uid(req), 'update', 'entity', req.params.id, req.body);
  bumpVersion();
  res.json({ ok: true });
});
api.delete('/entities/:id', admin, (req, res) => {
  if (get('SELECT 1 FROM transactions WHERE entity_id=? LIMIT 1', Number(req.params.id))) throw new HttpError(409, 'Enheten har transaktioner och kan inte tas bort');
  run('DELETE FROM pe_valuations WHERE entity_id=?', Number(req.params.id));
  run('DELETE FROM entities WHERE id=?', Number(req.params.id));
  audit(uid(req), 'delete', 'entity', req.params.id);
  bumpVersion();
  res.json({ ok: true });
});

api.get('/instruments', (req, res) => {
  const type = req.query.type as string | undefined;
  const list = instruments().filter((i) => !type || i.type === type);
  const m = getMarket();
  const d = today();
  res.json(list.map((i) => ({ ...i, lastPrice: m.price(i.id, d) })));
});

api.post('/instruments', editor, (req, res) => {
  const v = validateInstrument(req.body ?? {});
  if (v.isin && get('SELECT 1 FROM instruments WHERE isin=?', v.isin)) throw new HttpError(409, 'Ett instrument med detta ISIN finns redan');
  const r = run(
    'INSERT INTO instruments (type,name,isin,ticker,currency,country,region,sector,fund_category,manager,strategy,vintage,asset_class,sub_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    v.type, v.name, v.isin, v.ticker, v.currency, v.country, v.region, v.sector, v.fund_category, v.manager, v.strategy, v.vintage, v.asset_class, v.sub_class,
  );
  audit(uid(req), 'create', 'instrument', r.lastInsertRowid, v);
  bumpVersion();
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

api.put('/instruments/:id', editor, (req, res) => {
  const id = Number(req.params.id);
  const cur = get<Instrument>('SELECT * FROM instruments WHERE id=?', id);
  if (!cur) throw new HttpError(404, 'Instrumentet finns inte');
  const v = validateInstrument({ ...req.body, type: cur.type });
  if (v.currency !== cur.currency && get('SELECT 1 FROM transactions WHERE instrument_id=? LIMIT 1', id)) throw new HttpError(409, 'Valutan kan inte ändras när det finns transaktioner');
  run(
    'UPDATE instruments SET name=?,isin=?,ticker=?,currency=?,country=?,region=?,sector=?,fund_category=?,manager=?,strategy=?,vintage=?,asset_class=?,sub_class=? WHERE id=?',
    v.name, v.isin, v.ticker, v.currency, v.country, v.region, v.sector, v.fund_category, v.manager, v.strategy, v.vintage, v.asset_class, v.sub_class, id,
  );
  audit(uid(req), 'update', 'instrument', id, { before: cur, after: v });
  bumpVersion();
  res.json({ ok: true });
});

api.delete('/instruments/:id', editor, (req, res) => {
  const id = Number(req.params.id);
  if (get('SELECT 1 FROM transactions WHERE instrument_id=? LIMIT 1', id)) throw new HttpError(409, 'Instrumentet har transaktioner och kan inte tas bort');
  run('DELETE FROM instruments WHERE id=?', id);
  audit(uid(req), 'delete', 'instrument', id);
  bumpVersion();
  res.json({ ok: true });
});

/** Instrumentdetalj: innehav per juridisk enhet, transaktioner, kurs-/NAV-historik. */
api.get('/instruments/:id', (req, res) => {
  const id = Number(req.params.id);
  const ins = get<Instrument>('SELECT * FROM instruments WHERE id=?', id);
  if (!ins) throw new HttpError(404, 'Instrumentet finns inte');
  const ents = parseEntities(req.query.entities);
  const asOf = parseDate(req.query.asOf, today());
  const m = getMarket();
  const txs = all<Transaction & { entity_name: string }>(
    'SELECT t.*, e.name entity_name FROM transactions t JOIN entities e ON e.id=t.entity_id WHERE instrument_id=? ORDER BY trade_date DESC, t.id DESC', id,
  ).filter((t) => !ents || ents.includes(t.entity_id));
  const byEnt = new Map<number, Transaction[]>();
  for (const t of txs) byEnt.set(t.entity_id, [...(byEnt.get(t.entity_id) ?? []), t]);
  const names = new Map(entities().map((e) => [e.id, e.name]));
  let perEntity: (ListedHolding | PeHolding)[] = [];
  let total: ListedHolding | PeHolding | null = null;
  if (ins.type === 'PE_FUND') {
    const parts = [...byEnt].map(([e, t]) => peHolding(ins, e, t, m, asOf));
    perEntity = parts.map(stripPe);
    total = parts.length ? stripPe(parts.length === 1 ? parts[0] : sumPe(parts, asOf)) : null;
  } else {
    const parts = [...byEnt].map(([e, t]) => listedHolding(ins, e, t, m, asOf));
    perEntity = parts;
    total = parts.length ? sumListed(parts) : null;
  }
  const first = txs.length ? txs[txs.length - 1].trade_date : addDays(asOf, -365);
  res.json({
    instrument: ins,
    total,
    perEntity: perEntity.map((h) => ({ ...h, entityName: names.get(h.entityIds[0]) })),
    transactions: txs,
    prices: ins.type === 'PE_FUND' ? [] : m.priceHistory(id, addDays(first, -30), asOf),
    valuations: ins.type === 'PE_FUND'
      ? all('SELECT v.*, e.name entity_name FROM pe_valuations v JOIN entities e ON e.id=v.entity_id WHERE instrument_id=? ORDER BY date DESC', id)
        .filter((v) => !ents || ents.includes((v as { entity_id: number }).entity_id))
      : [],
  });
});

// ---------------------------------------------------------------------------
// Transaktioner
// ---------------------------------------------------------------------------

api.get('/transactions', (req, res) => {
  const where: string[] = [];
  const p: unknown[] = [];
  const ents = parseEntities(req.query.entities);
  if (ents) {
    where.push(`t.entity_id IN (${ents.map(() => '?').join(',') || 'NULL'})`);
    p.push(...ents);
  }
  if (req.query.instrument) { where.push('t.instrument_id = ?'); p.push(Number(req.query.instrument)); }
  if (req.query.type) { where.push('t.type = ?'); p.push(String(req.query.type)); }
  if (req.query.assetType) { where.push('i.type = ?'); p.push(String(req.query.assetType)); }
  if (isDate(req.query.from)) { where.push('t.trade_date >= ?'); p.push(req.query.from); }
  if (isDate(req.query.to)) { where.push('t.trade_date <= ?'); p.push(req.query.to); }
  if (req.query.q) { where.push('(i.name LIKE ? OR i.isin LIKE ? OR t.note LIKE ?)'); const q = `%${req.query.q}%`; p.push(q, q, q); }
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  const rows = all(
    `SELECT t.*, i.name instrument_name, i.currency, i.type instrument_type, e.name entity_name
     FROM transactions t JOIN instruments i ON i.id=t.instrument_id JOIN entities e ON e.id=t.entity_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.trade_date DESC, t.id DESC LIMIT ${limit}`,
    ...p,
  );
  res.json(rows);
});

api.post('/transactions', editor, (req, res) => {
  const v = validateTransaction(req.body ?? {});
  const r = run(
    'INSERT INTO transactions (entity_id,instrument_id,type,trade_date,settle_date,quantity,price,amount,fee,fx_rate,note,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    v.entity_id, v.instrument_id, v.type, v.trade_date, v.settle_date, v.quantity, v.price, v.amount, v.fee, v.fx_rate, v.note, uid(req),
  );
  audit(uid(req), 'create', 'transaction', r.lastInsertRowid, v);
  bumpVersion();
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

api.put('/transactions/:id', editor, (req, res) => {
  const id = Number(req.params.id);
  const cur = get('SELECT * FROM transactions WHERE id=?', id);
  if (!cur) throw new HttpError(404, 'Transaktionen finns inte');
  const v = validateTransaction({ ...req.body, id });
  run(
    'UPDATE transactions SET entity_id=?,instrument_id=?,type=?,trade_date=?,settle_date=?,quantity=?,price=?,amount=?,fee=?,fx_rate=?,note=? WHERE id=?',
    v.entity_id, v.instrument_id, v.type, v.trade_date, v.settle_date, v.quantity, v.price, v.amount, v.fee, v.fx_rate, v.note, id,
  );
  audit(uid(req), 'update', 'transaction', id, { before: cur, after: v });
  bumpVersion();
  res.json({ ok: true });
});

api.delete('/transactions/:id', editor, (req, res) => {
  const id = Number(req.params.id);
  const cur = get('SELECT * FROM transactions WHERE id=?', id);
  if (!cur) throw new HttpError(404, 'Transaktionen finns inte');
  run('DELETE FROM transactions WHERE id=?', id);
  audit(uid(req), 'delete', 'transaction', id, cur);
  bumpVersion();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Marknadsdata: kurser, valutor, NAV
// ---------------------------------------------------------------------------

api.get('/prices', (req, res) => {
  const id = Number(req.query.instrument);
  res.json(all('SELECT * FROM prices WHERE instrument_id=? ORDER BY date DESC LIMIT 1000', id));
});
api.post('/prices', editor, (req, res) => {
  const { instrument_id, date, price } = req.body ?? {};
  if (!get('SELECT 1 FROM instruments WHERE id=? AND type != ?', Number(instrument_id), 'PE_FUND')) throw new HttpError(400, 'Okänt noterat instrument');
  if (!isDate(date)) throw new HttpError(400, 'Ogiltigt datum');
  const p = num(price, 'Kurs', { min: 0 });
  run('INSERT INTO prices (instrument_id,date,price,source) VALUES (?,?,?,?) ON CONFLICT(instrument_id,date) DO UPDATE SET price=excluded.price, source=excluded.source', Number(instrument_id), date, p, 'Manuell');
  audit(uid(req), 'upsert', 'price', `${instrument_id}:${date}`, { price: p });
  bumpVersion();
  res.json({ ok: true });
});
api.delete('/prices/:instrument/:date', editor, (req, res) => {
  run('DELETE FROM prices WHERE instrument_id=? AND date=?', Number(req.params.instrument), req.params.date);
  audit(uid(req), 'delete', 'price', `${req.params.instrument}:${req.params.date}`);
  bumpVersion();
  res.json({ ok: true });
});

api.get('/fx', (_req, res) => {
  res.json(all(`SELECT f.currency, f.date, f.rate FROM fx_rates f
    JOIN (SELECT currency, MAX(date) d FROM fx_rates GROUP BY currency) l ON l.currency=f.currency AND l.d=f.date ORDER BY f.currency`));
});
api.get('/fx/:currency', (req, res) => {
  res.json(all('SELECT date, rate FROM fx_rates WHERE currency=? ORDER BY date DESC LIMIT 1000', req.params.currency.toUpperCase()));
});
api.post('/fx', editor, (req, res) => {
  const { currency, date, rate } = req.body ?? {};
  const c = String(currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(c) || c === 'SEK') throw new HttpError(400, 'Ogiltig valuta');
  if (!isDate(date)) throw new HttpError(400, 'Ogiltigt datum');
  const r = num(rate, 'Kurs', { min: 0 });
  run('INSERT INTO fx_rates (currency,date,rate) VALUES (?,?,?) ON CONFLICT(currency,date) DO UPDATE SET rate=excluded.rate', c, date, r);
  audit(uid(req), 'upsert', 'fx', `${c}:${date}`, { rate: r });
  bumpVersion();
  res.json({ ok: true });
});

api.post('/valuations', editor, (req, res) => {
  const { entity_id, instrument_id, date, nav } = req.body ?? {};
  if (!get('SELECT 1 FROM instruments WHERE id=? AND type=?', Number(instrument_id), 'PE_FUND')) throw new HttpError(400, 'Okänd PE-fond');
  if (!get('SELECT 1 FROM entities WHERE id=?', Number(entity_id))) throw new HttpError(400, 'Okänd juridisk enhet');
  if (!isDate(date)) throw new HttpError(400, 'Ogiltigt datum');
  const v = num(nav, 'NAV', { min: 0 });
  run('INSERT INTO pe_valuations (entity_id,instrument_id,date,nav,source) VALUES (?,?,?,?,?) ON CONFLICT(entity_id,instrument_id,date) DO UPDATE SET nav=excluded.nav, source=excluded.source',
    Number(entity_id), Number(instrument_id), date, v, req.body?.source || 'Manuell');
  audit(uid(req), 'upsert', 'valuation', `${entity_id}:${instrument_id}:${date}`, { nav: v });
  bumpVersion();
  res.json({ ok: true });
});
api.delete('/valuations/:entity/:instrument/:date', editor, (req, res) => {
  run('DELETE FROM pe_valuations WHERE entity_id=? AND instrument_id=? AND date=?', Number(req.params.entity), Number(req.params.instrument), req.params.date);
  audit(uid(req), 'delete', 'valuation', `${req.params.entity}:${req.params.instrument}:${req.params.date}`);
  bumpVersion();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Portfölj
// ---------------------------------------------------------------------------

type Enriched<H> = H & { instrument: Instrument; weight: number };

function enrichedSnapshot(ents: number[] | null, asOf: string, includeClosed = false) {
  return cached(`snap|${ents}|${asOf}|${includeClosed}`, () => {
    const data = portfolioData(ents);
    const s = snapshot(data, asOf, { includeClosed });
    const byId = new Map(data.instruments.map((i) => [i.id, i]));
    const total = s.listed.reduce((a, h) => a + h.mvBase, 0) + s.pe.reduce((a, h) => a + h.navBase, 0);
    const listed: Enriched<ListedHolding>[] = s.listed.map((h) => ({ ...h, instrument: byId.get(h.instrumentId)!, weight: total ? h.mvBase / total : 0 }));
    const pe: Enriched<PeHolding>[] = s.pe.map((h) => ({ ...h, instrument: byId.get(h.instrumentId)!, weight: total ? h.navBase / total : 0 }));
    return { listed, pe, total };
  });
}

const assetClass = (i: Instrument) => ASSET_CLASS_LABEL[i.asset_class] ?? 'Övrigt';

const DIMENSIONS: Record<string, { label: string; key: (i: Instrument) => string }> = {
  assetClass: { label: 'Tillgångsslag', key: assetClass },
  subClass: { label: 'Delsegment', key: (i) => `${assetClass(i)} – ${i.sub_class ?? 'övrigt'}` },
  currency: { label: 'Valuta', key: (i) => i.currency },
  region: { label: 'Region', key: (i) => i.region ?? 'Okänd' },
  sector: { label: 'Bransch/inriktning', key: (i) => i.sector ?? 'Okänd' },
  type: { label: 'Förvaltningsform', key: (i) => TYPE_LABELS[i.type] },
  manager: { label: 'Förvaltare', key: (i) => i.manager ?? (i.type === 'EQUITY' ? 'Direktägt' : 'Okänd') },
};

function allocations(ents: number[] | null, asOf: string, filter?: InstrumentType[], ac?: AssetClass) {
  const s = enrichedSnapshot(ents, asOf);
  const rows = [
    ...s.listed.map((h) => ({ i: h.instrument, v: h.mvBase })),
    ...s.pe.map((h) => ({ i: h.instrument, v: h.navBase })),
  ].filter((r) => (!filter || filter.includes(r.i.type)) && (!ac || r.i.asset_class === ac));
  const out: Record<string, { label: string; rows: ReturnType<typeof allocate> }> = {};
  for (const [k, d] of Object.entries(DIMENSIONS)) out[k] = { label: d.label, rows: allocate(rows.map((r) => ({ key: d.key(r.i), value: r.v }))) };
  // Per juridisk enhet
  const entRows: { key: string; value: number }[] = [];
  for (const e of entities().filter((e) => !ents || ents.includes(e.id))) {
    const es = enrichedSnapshot([e.id], asOf);
    const ok = (i: Instrument) => (!filter || filter.includes(i.type)) && (!ac || i.asset_class === ac);
    const v = [...es.listed.filter((h) => ok(h.instrument)).map((h) => h.mvBase),
      ...es.pe.filter((h) => ok(h.instrument)).map((h) => h.navBase)].reduce((a, b) => a + b, 0);
    if (v) entRows.push({ key: e.name, value: v });
  }
  out.entity = { label: 'Juridisk enhet', rows: allocate(entRows) };
  return out;
}

api.get('/portfolio/overview', (req, res) => {
  const ents = parseEntities(req.query.entities);
  const asOf = parseDate(req.query.asOf, today());
  const result = cached(`overview|${ents}|${asOf}`, () => {
    const data = portfolioData(ents);
    const s = enrichedSnapshot(ents, asOf);
    const first = data.transactions.reduce((m, t) => (t.trade_date < m ? t.trade_date : m), asOf);
    const from = first < addDays(asOf, -365 * 5) ? addDays(asOf, -365 * 5) : first;
    const series = valueSeries(data, from, asOf, 7);
    const sum = <T>(a: T[], f: (x: T) => number) => a.reduce((x, y) => x + f(y), 0);
    const listedMv = sum(s.listed, (h) => h.mvBase);
    const peNav = sum(s.pe, (h) => h.navBase);
    const top = [
      ...s.listed.map((h) => ({ id: h.instrumentId, name: h.instrument.name, type: h.instrument.type, value: h.mvBase, weight: h.weight })),
      ...s.pe.map((h) => ({ id: h.instrumentId, name: h.instrument.name, type: h.instrument.type, value: h.navBase, weight: h.weight })),
    ].sort((a, b) => b.value - a.value).slice(0, 10);
    const ytdStart = `${Number(asOf.slice(0, 4)) - 1}-12-31`;
    const ytdBase = [...series].reverse().find((p) => p.date <= ytdStart) ?? series[0];
    const last = series[series.length - 1];
    const ytdFlows = data.transactions.filter((t) => t.trade_date > ytdStart && t.trade_date <= asOf);
    return {
      asOf,
      totals: {
        marketValue: s.total,
        equities: sum(s.listed.filter((h) => h.instrument.type === 'EQUITY'), (h) => h.mvBase),
        funds: sum(s.listed.filter((h) => h.instrument.type === 'FUND'), (h) => h.mvBase),
        privateEquity: peNav,
        listed: listedMv,
        unrealized: sum(s.listed, (h) => h.unrealizedBase),
        uncalledCommitments: sum(s.pe, (h) => h.uncalledBase),
        totalExposure: s.total + sum(s.pe, (h) => h.uncalledBase),
        ytdChange: last && ytdBase ? last.value - ytdBase.value : 0,
        ytdNetFlows: ytdFlows.reduce((a, t) => a + (t.type === 'BUY' || t.type === 'CALL' ? (t.amount + t.fee) * t.fx_rate : t.type === 'SELL' || t.type === 'DISTRIBUTION' ? -(t.amount - t.fee) * t.fx_rate : 0), 0),
        ytdDividends: ytdFlows.filter((t) => t.type === 'DIVIDEND').reduce((a, t) => a + (t.amount - t.fee) * t.fx_rate, 0),
        holdingsCount: s.listed.length + s.pe.length,
      },
      series: series.map((p) => ({ ...p })),
      returns: periodReturns(series, asOf),
      top,
      allocations: allocations(ents, asOf),
      staleData: staleness(asOf),
    };
  });
  res.json(result);
});

/** Varnar för instrument med inaktuella kurser/NAV – viktigt för värderingskvalitet. */
function staleness(asOf: string) {
  const m = getMarket();
  const out: { id: number; name: string; lastDate: string | null; kind: string }[] = [];
  const s = enrichedSnapshot(null, asOf);
  for (const h of s.listed) {
    const p = m.price(h.instrumentId, asOf);
    if (!p || p.date < addDays(asOf, -7)) out.push({ id: h.instrumentId, name: h.instrument.name, lastDate: p?.date ?? null, kind: 'Kurs' });
  }
  for (const h of s.pe) if (!h.navReportDate || h.navReportDate < addDays(asOf, -200)) out.push({ id: h.instrumentId, name: h.instrument.name, lastDate: h.navReportDate, kind: 'NAV' });
  return out;
}

api.get('/portfolio/holdings', (req, res) => {
  const ents = parseEntities(req.query.entities);
  const asOf = parseDate(req.query.asOf, today());
  const type = req.query.type as InstrumentType | undefined;
  const ac = req.query.assetClass as AssetClass | undefined;
  const s = enrichedSnapshot(ents, asOf, req.query.includeClosed === '1');
  const ok = (i: Instrument) => (!type || i.type === type) && (!ac || i.asset_class === ac);
  const listed = s.listed.filter((h) => ok(h.instrument));
  const pe = s.pe.filter((h) => ok(h.instrument));
  const sum = <T>(a: T[], f: (x: T) => number) => a.reduce((x, y) => x + f(y), 0);
  const peAll = sum(pe, (h) => h.paidInBase);
  const value = sum(listed, (h) => h.mvBase) + sum(pe, (h) => h.navBase);
  const policy = ac ? get<{ target: number; min: number; max: number }>('SELECT target, min, max FROM policy_targets WHERE asset_class=?', ac) : null;
  res.json({
    asOf,
    listed,
    pe,
    total: { value, share: s.total ? value / s.total : 0, portfolio: s.total, policy: policy ?? null, uncalled: sum(pe, (h) => h.uncalledBase) },
    privateSummary: pe.length ? {
      commitment: sum(pe, (h) => h.commitmentBase), paidIn: peAll, distributed: sum(pe, (h) => h.distributedBase),
      nav: sum(pe, (h) => h.navBase), uncalled: sum(pe, (h) => h.uncalledBase), pnl: sum(pe, (h) => h.pnlBase),
      dpi: peAll ? sum(pe, (h) => h.distributedBase) / peAll : null,
      tvpi: peAll ? (sum(pe, (h) => h.distributedBase) + sum(pe, (h) => h.navBase)) / peAll : null,
      irr: peIrr(ents, asOf, new Set(pe.map((h) => h.instrumentId))),
    } : null,
    listedSummary: listed.length ? {
      marketValue: sum(listed, (h) => h.mvBase), cost: sum(listed, (h) => h.costBase), unrealized: sum(listed, (h) => h.unrealizedBase),
      realized: sum(listed, (h) => h.realizedBase), dividends: sum(listed, (h) => h.dividendsBase), fees: sum(listed, (h) => h.feesBase),
      fxEffect: sum(listed, (h) => h.fxEffectBase), totalPnl: sum(listed, (h) => h.totalPnlBase),
    } : null,
    allocations: allocations(ents, asOf, type ? [type] : undefined, ac),
  });
});

/** Sammanlagd IRR i SEK för slutna fonder (valfritt urval av instrument). */
function peIrr(ents: number[] | null, asOf: string, only?: Set<number>) {
  const data = portfolioData(ents);
  const parts = data.instruments.filter((i) => i.type === 'PE_FUND' && (!only || only.has(i.id))).flatMap((ins) => {
    const by = new Map<number, Transaction[]>();
    for (const t of data.transactions.filter((t) => t.instrument_id === ins.id)) by.set(t.entity_id, [...(by.get(t.entity_id) ?? []), t]);
    return [...by].map(([e, txs]) => peHolding(ins, e, txs, data.market, asOf));
  });
  if (!parts.length) return null;
  return portfolioIrrBase(parts, asOf);
}

api.get('/portfolio/pe-cashflows', (req, res) => {
  const ents = parseEntities(req.query.entities);
  const data = portfolioData(ents);
  const ac = req.query.assetClass as string | undefined;
  const peIds = new Set(data.instruments.filter((i) => i.type === 'PE_FUND' && (!ac || i.asset_class === ac)).map((i) => i.id));
  const asOf = parseDate(req.query.asOf, today());
  const byYear = new Map<string, { calls: number; distributions: number }>();
  for (const t of data.transactions) {
    if (!peIds.has(t.instrument_id) || t.trade_date > asOf) continue;
    const y = t.trade_date.slice(0, 4);
    const r = byYear.get(y) ?? { calls: 0, distributions: 0 };
    if (t.type === 'CALL' || t.type === 'FEE') r.calls += (t.amount + t.fee) * t.fx_rate;
    if (t.type === 'DISTRIBUTION') r.distributions += (t.amount - t.fee) * t.fx_rate;
    byYear.set(y, r);
  }
  let cum = 0;
  res.json([...byYear].sort().map(([year, r]) => {
    cum += r.distributions - r.calls;
    return { year, calls: -r.calls, distributions: r.distributions, net: r.distributions - r.calls, cumulative: cum };
  }));
});

// ---------------------------------------------------------------------------
// Import & rapporter
// ---------------------------------------------------------------------------

api.get('/import-kinds', (_req, res) => res.json(IMPORT_KINDS));

api.post('/import/:kind', editor, (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  const result = importCsv(req.params.kind as string, String(req.body?.csv ?? ''), { dryRun, userId: uid(req) });
  if (!dryRun && result.inserted > 0) {
    audit(uid(req), 'import', req.params.kind as string, null, { inserted: result.inserted });
    bumpVersion();
  }
  res.json(result);
});

const fmtNum = (n: number, d = 2) => (Math.round(n * 10 ** d) / 10 ** d).toString();

api.get('/reports/holdings.csv', (req, res) => {
  const ents = parseEntities(req.query.entities);
  const asOf = parseDate(req.query.asOf, today());
  const perEntity = req.query.perEntity === '1';
  const rows: Record<string, string | number>[] = [];
  const targets = perEntity ? entities().filter((e) => !ents || ents.includes(e.id)).map((e) => ({ ids: [e.id], name: e.name })) : [{ ids: ents, name: 'Valda enheter' }];
  for (const t of targets) {
    const s = enrichedSnapshot(t.ids, asOf);
    for (const h of s.listed) rows.push({
      Datum: asOf, Enhet: t.name, Typ: TYPE_LABELS[h.instrument.type], Instrument: h.instrument.name, ISIN: h.instrument.isin ?? '', Valuta: h.instrument.currency,
      Antal: fmtNum(h.quantity, 4), 'GAV (lokal)': fmtNum(h.avgCostLocal, 4), Kurs: fmtNum(h.price, 4), Kursdatum: h.priceDate ?? '', Valutakurs: fmtNum(h.fx, 4),
      'Anskaffningsvärde SEK': fmtNum(h.costBase), 'Marknadsvärde SEK': fmtNum(h.mvBase), 'Orealiserat SEK': fmtNum(h.unrealizedBase),
      'Varav valuta SEK': fmtNum(h.fxEffectBase), 'Realiserat SEK': fmtNum(h.realizedBase), 'Utdelningar SEK': fmtNum(h.dividendsBase), Andel: fmtNum(h.weight * 100, 2),
    });
    for (const h of s.pe) rows.push({
      Datum: asOf, Enhet: t.name, Typ: 'PE-fond', Instrument: h.instrument.name, ISIN: h.instrument.isin ?? '', Valuta: h.instrument.currency,
      Åtagande: fmtNum(h.commitment), Inbetalt: fmtNum(h.paidIn), Outnyttjat: fmtNum(h.uncalled), Utdelat: fmtNum(h.distributed), NAV: fmtNum(h.nav),
      'NAV-rapportdatum': h.navReportDate ?? '', Valutakurs: fmtNum(h.fx, 4), 'Marknadsvärde SEK': fmtNum(h.navBase), 'Outnyttjat SEK': fmtNum(h.uncalledBase),
      DPI: h.dpi == null ? '' : fmtNum(h.dpi, 3), TVPI: h.tvpi == null ? '' : fmtNum(h.tvpi, 3), 'IRR SEK %': h.irrBase == null ? '' : fmtNum(h.irrBase * 100, 2), Andel: fmtNum(h.weight * 100, 2),
    });
  }
  sendCsv(res, `innehav_${asOf}.csv`, rows);
});

api.get('/reports/transactions.csv', (req, res) => {
  const ents = parseEntities(req.query.entities);
  const from = parseDate(req.query.from, '1900-01-01');
  const to = parseDate(req.query.to, today());
  const rows = all<Transaction & { instrument_name: string; isin: string; currency: string; entity_name: string }>(
    `SELECT t.*, i.name instrument_name, i.isin, i.currency, e.name entity_name FROM transactions t
     JOIN instruments i ON i.id=t.instrument_id JOIN entities e ON e.id=t.entity_id
     WHERE t.trade_date BETWEEN ? AND ? ORDER BY t.trade_date, t.id`, from, to,
  ).filter((t) => !ents || ents.includes(t.entity_id));
  sendCsv(res, `transaktioner_${from}_${to}.csv`, rows.map((t) => ({
    Affärsdag: t.trade_date, Likviddag: t.settle_date ?? '', Enhet: t.entity_name, Instrument: t.instrument_name, ISIN: t.isin ?? '',
    Typ: TX_LABELS[t.type], Antal: fmtNum(t.quantity, 4), Kurs: fmtNum(t.price, 4), Belopp: fmtNum(t.amount), Avgift: fmtNum(t.fee),
    Valuta: t.currency, Valutakurs: fmtNum(t.fx_rate, 4), 'Belopp SEK': fmtNum(t.amount * t.fx_rate), Notering: t.note ?? '',
  })));
});

function sendCsv(res: import('express').Response, filename: string, rows: Record<string, unknown>[]) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + toCsv(rows));
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

api.get('/audit', admin, (req, res) => {
  res.json(all(`SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT ?`, Math.min(Number(req.query.limit) || 200, 2000)));
});

api.get('/users', admin, (_req, res) => res.json(all('SELECT id, email, name, role, created_at FROM users ORDER BY name')));
api.post('/users', admin, (req, res) => {
  const { email, name, role, password } = req.body ?? {};
  if (!email || !name || !password) throw new HttpError(400, 'E-post, namn och lösenord krävs');
  if (String(password).length < 10) throw new HttpError(400, 'Lösenordet måste ha minst 10 tecken');
  if (!['admin', 'editor', 'viewer'].includes(role)) throw new HttpError(400, 'Ogiltig roll');
  if (get('SELECT 1 FROM users WHERE email=?', email)) throw new HttpError(409, 'E-postadressen används redan');
  const r = run('INSERT INTO users (email,name,role,password_hash) VALUES (?,?,?,?)', email, name, role, hashPassword(password));
  audit(uid(req), 'create', 'user', r.lastInsertRowid, { email, name, role });
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
api.put('/users/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  const { name, role, password } = req.body ?? {};
  if (role && !['admin', 'editor', 'viewer'].includes(role)) throw new HttpError(400, 'Ogiltig roll');
  if (id === uid(req) && role && role !== 'admin') throw new HttpError(400, 'Du kan inte ta bort din egen administratörsbehörighet');
  tx(() => {
    if (name) run('UPDATE users SET name=? WHERE id=?', name, id);
    if (role) run('UPDATE users SET role=? WHERE id=?', role, id);
    if (password) {
      if (String(password).length < 10) throw new HttpError(400, 'Lösenordet måste ha minst 10 tecken');
      run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), id);
      run('DELETE FROM sessions WHERE user_id=?', id);
    }
  });
  audit(uid(req), 'update', 'user', id, { name, role, passwordChanged: !!password });
  res.json({ ok: true });
});
api.delete('/users/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  if (id === uid(req)) throw new HttpError(400, 'Du kan inte ta bort dig själv');
  run('DELETE FROM users WHERE id=?', id);
  audit(uid(req), 'delete', 'user', id);
  res.json({ ok: true });
});
