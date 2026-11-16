/** Portföljanalys på total nivå: policyallokering, avkastning per tillgångsslag, likviditet och rapportbevakning. */
import { Router } from 'express';
import { all, get, run, audit } from './db.ts';
import { HttpError, requireRole } from './auth.ts';
import { cached, parseDate, parseEntities, portfolioData, today } from './data.ts';
import { TA_DEFAULTS, addDays, exposureUncalled, periodReturns, portfolioIrr, snapshot, taForecast, totalValue, valueSeries } from './calc.ts';
import { ASSET_CLASSES, type AssetClass, type Instrument } from '../shared/types.ts';

export const portfolioRoutes = Router();

function snap(ents: number[] | null, asOf: string) {
  return cached(`psnap|${ents}|${asOf}`, () => {
    const data = portfolioData(ents);
    const s = snapshot(data, asOf);
    const byId = new Map(data.instruments.map((i) => [i.id, i]));
    return { data, s, byId };
  });
}

// ---------------------------------------------------------------------------
// Allokering mot policyportfölj
// ---------------------------------------------------------------------------

portfolioRoutes.get('/portfolio/allocation', (req, res) => {
  const ents = parseEntities(req.query.entities);
  const asOf = parseDate(req.query.asOf, today());
  const { s, byId } = snap(ents, asOf);
  const targets = new Map(all<{ asset_class: AssetClass; target: number; min: number; max: number }>('SELECT * FROM policy_targets').map((t) => [t.asset_class, t]));
  const rows = ASSET_CLASSES.map((a) => ({ key: a.key, label: a.label, path: a.path, value: 0, uncalled: 0, subs: new Map<string, number>() }));
  const find = (k: AssetClass) => rows.find((r) => r.key === k)!;
  for (const h of s.listed) {
    const i = byId.get(h.instrumentId)!;
    const r = find(i.asset_class);
    r.value += h.mvBase;
    r.subs.set(i.sub_class ?? 'Övrigt', (r.subs.get(i.sub_class ?? 'Övrigt') ?? 0) + h.mvBase);
  }
  for (const h of s.pe) {
    const i = byId.get(h.instrumentId)!;
    const r = find(i.asset_class);
    r.value += h.navBase;
    r.uncalled += exposureUncalled(h);
    r.subs.set(i.sub_class ?? 'Övrigt', (r.subs.get(i.sub_class ?? 'Övrigt') ?? 0) + h.navBase);
  }
  const total = rows.reduce((a, r) => a + r.value, 0);
  const totalExp = total + rows.reduce((a, r) => a + r.uncalled, 0);
  res.json({
    asOf,
    total,
    totalExposure: totalExp,
    rows: rows.map((r) => {
      const t = targets.get(r.key);
      const share = total ? r.value / total : 0;
      return {
        key: r.key, label: r.label, path: r.path, value: r.value, share, uncalled: r.uncalled,
        exposureShare: totalExp ? (r.value + r.uncalled) / totalExp : 0,
        target: t?.target ?? null, min: t?.min ?? null, max: t?.max ?? null,
        deviation: t ? share - t.target : null,
        status: !t ? 'none' : share < t.min ? 'under' : share > t.max ? 'over' : 'ok',
        rebalance: t ? (t.target - share) * total : null,
        subs: [...r.subs].map(([k, v]) => ({ key: k, value: v, share: r.value ? v / r.value : 0 })).sort((a, b) => b.value - a.value),
      };
    }),
  });
});

portfolioRoutes.put('/policy-targets', requireRole('admin'), (req, res) => {
  const rows = req.body?.rows as { asset_class: AssetClass; target: number; min: number; max: number }[];
  if (!Array.isArray(rows)) throw new HttpError(400, 'Ogiltiga data');
  const sum = rows.reduce((a, r) => a + Number(r.target), 0);
  if (Math.abs(sum - 1) > 0.0001) throw new HttpError(400, `Målvikterna summerar till ${(sum * 100).toFixed(1)} % – de måste summera till 100 %`);
  for (const r of rows) {
    if (!ASSET_CLASSES.some((a) => a.key === r.asset_class)) throw new HttpError(400, 'Okänt tillgångsslag');
    if (!(r.min <= r.target && r.target <= r.max)) throw new HttpError(400, `${r.asset_class}: målvikten måste ligga inom intervallet`);
  }
  run('DELETE FROM policy_targets');
  for (const r of rows) run('INSERT INTO policy_targets (asset_class, target, min, max) VALUES (?,?,?,?)', r.asset_class, r.target, r.min, r.max);
  audit(req.user?.id ?? null, 'update', 'policy_targets', null, rows);
  res.json({ ok: true });
});
portfolioRoutes.get('/policy-targets', (_req, res) => res.json(all('SELECT * FROM policy_targets')));

// ---------------------------------------------------------------------------
// Avkastning per tillgångsslag
// ---------------------------------------------------------------------------

portfolioRoutes.get('/portfolio/performance', (req, res) => {
  const ents = parseEntities(req.query.entities);
  const asOf = parseDate(req.query.asOf, today());
  const result = cached(`perf|${ents}|${asOf}`, () => {
    const data = portfolioData(ents);
    const first = data.transactions.reduce((m, t) => (t.trade_date < m ? t.trade_date : m), asOf);
    const from = first < addDays(asOf, -365 * 5) ? addDays(asOf, -365 * 5) : first;
    const rowFor = (label: string, key: string, ids: Set<number> | null) => {
      const sub = ids ? { ...data, instruments: data.instruments.filter((i) => ids.has(i.id)), transactions: data.transactions.filter((t) => ids.has(t.instrument_id)) } : data;
      const series = valueSeries(sub, from, asOf, 7);
      const snap = snapshot(sub, asOf);
      const value = totalValue(snap);
      const priv = sub.instruments.filter((i) => i.type === 'PE_FUND');
      let irr: number | null = null;
      if (!ids) {
        // Total portfölj: internräntan för alla kassaflöden i portföljen med dagens värde som slutvärde
        irr = portfolioIrr(sub.transactions, value, asOf);
      } else if (priv.length) {
        // Tillgångsslag: som tidigare de slutna fondernas IRR
        const privIds = new Set(priv.map((i) => i.id));
        irr = portfolioIrr(sub.transactions.filter((t) => privIds.has(t.instrument_id)), snap.pe.reduce((a, h) => a + h.navBase, 0), asOf);
      }
      return { key, label, value, returns: periodReturns(series, asOf), irr, hasPrivate: priv.length > 0, series: series.filter((_, i) => i % 2 === 0 || i === series.length - 1).map((p) => ({ date: p.date, index: p.index })) };
    };
    const rows = ASSET_CLASSES.map((a) => {
      const ids = new Set(data.instruments.filter((i) => i.asset_class === a.key).map((i) => i.id));
      return ids.size && data.transactions.some((t) => ids.has(t.instrument_id)) ? rowFor(a.label, a.key, ids) : null;
    }).filter((r): r is NonNullable<typeof r> => !!r);
    return { asOf, total: rowFor('Total portfölj', 'TOTAL', null), rows };
  });
  res.json(result);
});

// ---------------------------------------------------------------------------
// Likviditet och åtaganden
// ---------------------------------------------------------------------------

portfolioRoutes.get('/portfolio/liquidity', (req, res) => {
  const ents = parseEntities(req.query.entities);
  const asOf = parseDate(req.query.asOf, today());
  const years = Math.min(Number(req.query.years) || 6, 12);
  const { data, s, byId } = snap(ents, asOf);
  const asOfYear = Number(asOf.slice(0, 4));
  // Aviserade (framtida) kapitalanrop och utdelningar som redan registrerats
  const upcoming = data.transactions
    .filter((t) => t.trade_date > asOf && (t.type === 'CALL' || t.type === 'DISTRIBUTION'))
    .map((t) => ({ ...t, instrument: byId.get(t.instrument_id)!.name, currency: byId.get(t.instrument_id)!.currency, sek: (t.amount + (t.type === 'CALL' ? t.fee : -t.fee)) * t.fx_rate }))
    .sort((a, b) => a.trade_date.localeCompare(b.trade_date));
  const funds = s.pe.map((h) => {
    const i = byId.get(h.instrumentId)!;
    const params = TA_DEFAULTS[i.sub_class ?? ''] ?? TA_DEFAULTS[i.strategy ?? ''] ?? TA_DEFAULTS.default;
    const f = taForecast({ vintage: i.vintage ?? asOfYear, nav: h.navBase, uncalled: exposureUncalled(h), asOfYear, years, params });
    return { id: i.id, name: i.name, assetClass: i.asset_class, subClass: i.sub_class, vintage: i.vintage, currency: i.currency, nav: h.navBase, uncalled: h.uncalledBase, commitment: h.commitmentBase, calledPct: h.calledPct, forecast: f, params };
  });
  const yearsArr = Array.from({ length: years }, (_, k) => asOfYear + k + 1);
  const totals = yearsArr.map((y) => {
    const rows = funds.map((f) => f.forecast.find((x) => x.year === y)!);
    return { year: y, calls: rows.reduce((a, r) => a + r.calls, 0), distributions: rows.reduce((a, r) => a + r.distributions, 0), nav: rows.reduce((a, r) => a + r.nav, 0), uncalled: rows.reduce((a, r) => a + r.uncalled, 0) };
  });
  const listedLiquid = s.listed.reduce((a, h) => a + (byId.get(h.instrumentId)!.asset_class !== 'ABSOLUTE_RETURN' ? h.mvBase : 0), 0);
  const uncalled = s.pe.reduce((a, h) => a + exposureUncalled(h), 0);
  res.json({
    asOf, uncalled, listedLiquid, coverage: uncalled ? listedLiquid / uncalled : null,
    upcoming, funds, totals,
    note: 'Prognos enligt Takahashi–Alexander-modellen med schablonparametrar per strategi. Faktiska anrop och utdelningar styrs av förvaltarna.',
  });
});

// ---------------------------------------------------------------------------
// Rapportbevakning: har varje GP levererat kvartalsrapport (NAV)?
// ---------------------------------------------------------------------------

const quarterEnds = (asOf: string) => {
  const y = Number(asOf.slice(0, 4));
  const out: string[] = [];
  for (const yy of [y - 1, y]) for (const q of ['03-31', '06-30', '09-30', '12-31']) out.push(`${yy}-${q}`);
  return out.filter((d) => d < asOf);
};

portfolioRoutes.get('/portfolio/reporting', (req, res) => {
  const ents = parseEntities(req.query.entities);
  const asOf = parseDate(req.query.asOf, today());
  const lag = Number(get<{ value: string }>("SELECT value FROM settings WHERE key='report_lag_days'")?.value ?? 90);
  const qs = quarterEnds(asOf);
  const latestQuarter = qs[qs.length - 1];
  const due = [...qs].reverse().find((q) => addDays(q, lag) <= asOf) ?? qs[0]; // senaste kvartal vars rapport borde ha kommit
  const commitments = all<{ entity_id: number; entity: string; instrument_id: number }>(
    `SELECT DISTINCT t.entity_id, e.name entity, t.instrument_id FROM transactions t JOIN entities e ON e.id=t.entity_id
     JOIN instruments i ON i.id=t.instrument_id WHERE i.type='PE_FUND'`,
  ).filter((c) => !ents || ents.includes(c.entity_id));
  const rows = commitments.map((c) => {
    const ins = get<Instrument>('SELECT * FROM instruments WHERE id=?', c.instrument_id)!;
    const last = get<{ date: string; document_id: number | null }>('SELECT date, document_id FROM pe_valuations WHERE entity_id=? AND instrument_id=? AND date<=? ORDER BY date DESC LIMIT 1', c.entity_id, c.instrument_id, asOf);
    const latest = last?.date ?? null;
    const status = latest && latest >= latestQuarter ? 'received' : latest && latest >= due ? 'awaiting' : 'overdue';
    const daysLate = status === 'overdue' ? Math.round((Date.parse(asOf) - Date.parse(addDays(due, lag))) / 864e5) : 0;
    return { entityId: c.entity_id, entity: c.entity, instrumentId: ins.id, fund: ins.name, manager: ins.manager, assetClass: ins.asset_class, latest, documentId: last?.document_id ?? null, status, daysLate };
  }).sort((a, b) => ({ overdue: 0, awaiting: 1, received: 2 }[a.status]! - { overdue: 0, awaiting: 1, received: 2 }[b.status]!) || a.fund.localeCompare(b.fund));
  res.json({ asOf, latestQuarter, due, lag, rows });
});
