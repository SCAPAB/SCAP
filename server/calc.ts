/**
 * Beräkningsmotor. Rena funktioner utan databasberoende så att de kan testas isolerat.
 *
 * Principer
 *  - Rapportvaluta är SEK. fx = SEK per 1 enhet utländsk valuta.
 *  - Anskaffningsvärde för noterade innehav enligt genomsnittsmetoden, per juridisk enhet.
 *    Anskaffningsvärdet i SEK räknas med valutakursen på respektive affärsdag.
 *  - PE-fonder: senast rapporterade NAV rullas fram med kapitalanrop och utdelningar
 *    efter rapportdatum. Saknas NAV används inbetalt minus utdelat (värdering till kostnad).
 *  - Avkastning för portföljen: tidsviktad (TWR), länkad Modified Dietz per delperiod.
 */
import type {
  AllocationRow, Cashflow, Instrument, ListedHolding, PeHolding, PeriodReturn, SeriesPoint, Transaction,
} from '../shared/types.ts';
import { xirr } from './xirr.ts';
export { xirr as xirrSafe };

const EPS = 1e-9;
/** Hur gammal en automatiskt hämtad valutakurs för en affär får vara (kalenderdagar före affärsdagen). */
export const FX_TRADE_MAX_DAYS = 7;

// ---------------------------------------------------------------------------
// Marknadsdata med "senast kända värde per datum"-uppslag
// ---------------------------------------------------------------------------

class AsOfSeries {
  dates: string[] = [];
  values: number[] = [];
  push(date: string, value: number) {
    this.dates.push(date);
    this.values.push(value);
  }
  sort() {
    const idx = this.dates.map((_, i) => i).sort((a, b) => this.dates[a].localeCompare(this.dates[b]));
    this.dates = idx.map((i) => this.dates[i]);
    this.values = idx.map((i) => this.values[i]);
  }
  /** Index för senaste punkt <= date, eller -1. */
  indexAsOf(date: string): number {
    let lo = 0;
    let hi = this.dates.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.dates[mid] <= date) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }
  asOf(date: string): { date: string; value: number } | null {
    const i = this.indexAsOf(date);
    return i < 0 ? null : { date: this.dates[i], value: this.values[i] };
  }
}

export interface MarketInput {
  prices: { instrument_id: number; date: string; price: number }[];
  fx: { currency: string; date: string; rate: number }[];
  valuations: { entity_id: number; instrument_id: number; date: string; nav: number }[];
}

export class Market {
  private prices = new Map<number, AsOfSeries>();
  private fx = new Map<string, AsOfSeries>();
  private navs = new Map<string, AsOfSeries>();

  constructor(input: MarketInput) {
    const add = <K>(m: Map<K, AsOfSeries>, k: K, d: string, v: number) => {
      let s = m.get(k);
      if (!s) m.set(k, (s = new AsOfSeries()));
      s.push(d, v);
    };
    for (const p of input.prices) add(this.prices, p.instrument_id, p.date, p.price);
    for (const f of input.fx) add(this.fx, f.currency.toUpperCase(), f.date, f.rate);
    for (const v of input.valuations) add(this.navs, `${v.entity_id}:${v.instrument_id}`, v.date, v.nav);
    for (const m of [this.prices, this.fx, this.navs] as Map<unknown, AsOfSeries>[]) for (const s of m.values()) s.sort();
  }

  price(instrumentId: number, date: string) {
    return this.prices.get(instrumentId)?.asOf(date) ?? null;
  }

  /**
   * SEK per 1 enhet valuta per datum: senast kända kurs på eller före datum.
   * En kurs från ett senare datum används aldrig – saknas kurs blir resultatet NaN (= kan inte värderas).
   */
  fxRate(currency: string, date: string): number {
    return this.fxAsOf(currency, date)?.value ?? NaN;
  }

  /** Senast kända valutakurs på eller före datum, med kursens datum. SEK ger alltid 1. */
  fxAsOf(currency: string, date: string): { date: string; value: number } | null {
    const c = currency.toUpperCase();
    if (c === 'SEK') return { date, value: 1 };
    return this.fx.get(c)?.asOf(date) ?? null;
  }

  /**
   * Valutakurs för en affär: senast kända kurs högst `maxDays` kalenderdagar före affärsdagen
   * (helger och helgdagar), aldrig en senare kurs. null = kursen måste anges manuellt.
   */
  fxForTrade(currency: string, date: string, maxDays = FX_TRADE_MAX_DAYS): { date: string; value: number } | null {
    const r = this.fxAsOf(currency, date);
    return r && r.date >= addDays(date, -maxDays) ? r : null;
  }

  /** Första registrerade kursdatum för valutan (för felmeddelanden). */
  fxFirstDate(currency: string): string | null {
    return this.fx.get(currency.toUpperCase())?.dates[0] ?? null;
  }

  nav(entityId: number, instrumentId: number, date: string) {
    return this.navs.get(`${entityId}:${instrumentId}`)?.asOf(date) ?? null;
  }

  priceHistory(instrumentId: number, from: string, to: string) {
    const s = this.prices.get(instrumentId);
    if (!s) return [];
    const out: { date: string; price: number }[] = [];
    for (let i = 0; i < s.dates.length; i++) if (s.dates[i] >= from && s.dates[i] <= to) out.push({ date: s.dates[i], price: s.values[i] });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Noterade innehav (aktier och fonder) – genomsnittsmetoden
// ---------------------------------------------------------------------------

function emptyListed(instrumentId: number, entityIds: number[]): ListedHolding {
  return {
    instrumentId, entityIds, quantity: 0, avgCostLocal: 0, costLocal: 0, costBase: 0, price: 0, priceDate: null, fx: 1,
    mvLocal: 0, mvBase: 0, unrealizedLocal: 0, unrealizedBase: 0, fxEffectBase: 0, realizedBase: 0,
    dividendsBase: 0, feesBase: 0, totalPnlBase: 0, unrealizedPct: null,
  };
}

/** Ordning inom en dag: köp före försäljning, därefter registreringsordning. Samma ordning används i kontrollen av innehav. */
const DAY_ORDER: Partial<Record<Transaction['type'], number>> = { BUY: 0, SELL: 1 };
export function sortTx<T extends Pick<Transaction, 'trade_date' | 'type' | 'id'>>(txs: T[]): T[] {
  return [...txs].sort((a, b) => a.trade_date.localeCompare(b.trade_date) || (DAY_ORDER[a.type] ?? 0) - (DAY_ORDER[b.type] ?? 0) || a.id - b.id);
}

/**
 * Första tillfälle då antalet blir negativt (försäljning över innehavet), eller null.
 * Innehavet kontrolleras vid slutet av varje affärsdag över hela tidslinjen – inte bara per en affärsdag –
 * så att en bakdaterad försäljning, ett borttaget köp eller ett flyttat datum inte kan skapa ett omöjligt läge.
 */
export function findOversell(txs: Pick<Transaction, 'trade_date' | 'type' | 'id' | 'quantity'>[]): { date: string; quantity: number; held: number } | null {
  let q = 0;
  for (const t of sortTx(txs)) {
    if (t.type === 'BUY') q += t.quantity;
    else if (t.type === 'SELL') {
      if (t.quantity > q + 1e-6) return { date: t.trade_date, quantity: t.quantity, held: Math.max(0, q) };
      q -= t.quantity;
    }
  }
  return null;
}

/** Beräknar en position för EN juridisk enhet i ETT instrument per datum. */
export function listedHolding(
  instrument: Instrument, entityId: number, txs: Transaction[], market: Market, asOf: string,
): ListedHolding {
  const h = emptyListed(instrument.id, [entityId]);
  let lastTradePrice: { date: string; price: number } | null = null;
  const sorted = sortTx(txs.filter((t) => t.trade_date <= asOf));
  for (const t of sorted) {
    switch (t.type) {
      case 'BUY': {
        const cost = t.amount + t.fee;
        h.quantity += t.quantity;
        h.costLocal += cost;
        h.costBase += cost * t.fx_rate;
        lastTradePrice = { date: t.trade_date, price: t.price };
        break;
      }
      case 'SELL': {
        // Försäljning över innehavet ska stoppas vid registrering. Finns det ändå (äldre data) räknas
        // bara likviden för det antal som faktiskt ägdes som intäkt.
        const q = Math.min(t.quantity, h.quantity);
        const share = h.quantity > EPS ? q / h.quantity : 0;
        const costOutLocal = h.costLocal * share;
        const costOutBase = h.costBase * share;
        const proceeds = (t.amount - t.fee) * (t.quantity > EPS ? q / t.quantity : 0);
        h.realizedBase += proceeds * t.fx_rate - costOutBase;
        h.quantity -= q;
        h.costLocal -= costOutLocal;
        h.costBase -= costOutBase;
        if (h.quantity < EPS) {
          h.quantity = 0;
          h.costLocal = 0;
          h.costBase = 0;
        }
        lastTradePrice = { date: t.trade_date, price: t.price };
        break;
      }
      case 'DIVIDEND':
        h.dividendsBase += (t.amount - t.fee) * t.fx_rate;
        break;
      case 'FEE':
        h.feesBase += (t.amount + t.fee) * t.fx_rate;
        break;
    }
  }
  const px = market.price(instrument.id, asOf) ?? (lastTradePrice ? { date: lastTradePrice.date, value: lastTradePrice.price } : null);
  h.price = px?.value ?? 0;
  h.priceDate = px?.date ?? null;
  h.fx = market.fxRate(instrument.currency, asOf);
  h.avgCostLocal = h.quantity > EPS ? h.costLocal / h.quantity : 0;
  h.mvLocal = h.quantity * h.price;
  h.mvBase = h.mvLocal * h.fx;
  h.unrealizedLocal = h.mvLocal - h.costLocal;
  h.unrealizedBase = h.mvBase - h.costBase;
  h.fxEffectBase = h.costLocal * h.fx - h.costBase;
  h.totalPnlBase = h.unrealizedBase + h.realizedBase + h.dividendsBase - h.feesBase;
  h.unrealizedPct = h.costBase > EPS ? h.unrealizedBase / h.costBase : null;
  return h;
}

export function sumListed(parts: ListedHolding[]): ListedHolding {
  const h = emptyListed(parts[0].instrumentId, []);
  for (const p of parts) {
    h.entityIds.push(...p.entityIds);
    for (const k of ['quantity', 'costLocal', 'costBase', 'mvLocal', 'mvBase', 'unrealizedLocal', 'unrealizedBase', 'fxEffectBase', 'realizedBase', 'dividendsBase', 'feesBase', 'totalPnlBase'] as const) h[k] += p[k];
    h.price = p.price;
    h.priceDate = p.priceDate;
    h.fx = p.fx;
  }
  h.avgCostLocal = h.quantity > EPS ? h.costLocal / h.quantity : 0;
  h.unrealizedPct = h.costBase > EPS ? h.unrealizedBase / h.costBase : null;
  return h;
}

// ---------------------------------------------------------------------------
// PE-fonder
// ---------------------------------------------------------------------------

interface PeWork extends PeHolding {
  flowsLocal: Cashflow[];
  flowsBase: Cashflow[];
}

export function peHolding(instrument: Instrument, entityId: number, txs: Transaction[], market: Market, asOf: string): PeWork {
  const h: PeWork = {
    instrumentId: instrument.id, entityIds: [entityId], commitment: 0, called: 0, uncalled: 0, distributed: 0, fees: 0, paidIn: 0,
    nav: 0, navReportDate: null, navEstimated: false, fx: 1, commitmentBase: 0, paidInBase: 0, distributedBase: 0, navBase: 0,
    uncalledBase: 0, pnlBase: 0, dpi: null, rvpi: null, tvpi: null, irr: null, irrBase: null, calledPct: null,
    flowsLocal: [], flowsBase: [],
  };
  const sorted = txs.filter((t) => t.trade_date <= asOf).sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.id - b.id);
  const val = market.nav(entityId, instrument.id, asOf);
  let rollForward = 0; // flöden efter senaste NAV-rapport
  let drawnOnCommitment = 0; // anropat som minskar åtagandet
  let recallable = 0; // återinkallningsbara utdelningar som återställer åtagandet
  for (const t of sorted) {
    const amt = t.amount + (t.type === 'COMMITMENT' ? 0 : t.fee);
    switch (t.type) {
      case 'COMMITMENT':
        h.commitment += t.amount;
        break;
      case 'CALL':
        // amount = investering (ökar NAV), fee = förvaltningsavgift/kostnader (ingår i inbetalt men inte i NAV)
        h.called += amt;
        drawnOnCommitment += amt - (t.outside_commitment ?? 0);
        h.paidInBase += amt * t.fx_rate;
        h.flowsLocal.push({ date: t.trade_date, amount: -amt });
        h.flowsBase.push({ date: t.trade_date, amount: -amt * t.fx_rate });
        if (!val || t.trade_date > val.date) rollForward += t.amount;
        break;
      case 'FEE':
        h.fees += amt;
        h.paidInBase += amt * t.fx_rate;
        h.flowsLocal.push({ date: t.trade_date, amount: -amt });
        h.flowsBase.push({ date: t.trade_date, amount: -amt * t.fx_rate });
        break;
      case 'DISTRIBUTION': {
        const net = t.amount - t.fee;
        h.distributed += net;
        recallable += t.recallable ?? 0;
        h.distributedBase += net * t.fx_rate;
        h.flowsLocal.push({ date: t.trade_date, amount: net });
        h.flowsBase.push({ date: t.trade_date, amount: net * t.fx_rate });
        if (!val || t.trade_date > val.date) rollForward -= net;
        break;
      }
    }
  }
  h.fx = market.fxRate(instrument.currency, asOf);
  h.paidIn = h.called + h.fees;
  h.uncalled = Math.max(0, h.commitment - drawnOnCommitment + recallable);
  h.calledPct = h.commitment > EPS ? drawnOnCommitment / h.commitment : null;
  if (val) {
    h.nav = Math.max(0, val.value + rollForward);
    h.navReportDate = val.date;
    h.navEstimated = rollForward !== 0;
  } else {
    h.nav = Math.max(0, rollForward);
    h.navEstimated = h.nav > 0;
  }
  finishPe(h, asOf);
  return h;
}

function finishPe(h: PeWork, asOf: string) {
  h.commitmentBase = h.commitment * h.fx;
  h.navBase = h.nav * h.fx;
  h.uncalledBase = h.uncalled * h.fx;
  h.pnlBase = h.navBase + h.distributedBase - h.paidInBase;
  if (h.paidIn > EPS) {
    h.dpi = h.distributed / h.paidIn;
    h.rvpi = h.nav / h.paidIn;
    h.tvpi = h.dpi + h.rvpi;
  } else h.dpi = h.rvpi = h.tvpi = null;
  h.irr = xirr([...h.flowsLocal, { date: asOf, amount: h.nav }]);
  h.irrBase = xirr([...h.flowsBase, { date: asOf, amount: h.navBase }]);
}

export function sumPe(parts: PeWork[], asOf: string): PeWork {
  const h: PeWork = { ...parts[0], entityIds: [], flowsLocal: [], flowsBase: [] };
  for (const k of ['commitment', 'called', 'uncalled', 'distributed', 'fees', 'paidIn', 'nav', 'paidInBase', 'distributedBase'] as const) h[k] = 0;
  h.navEstimated = false;
  for (const p of parts) {
    h.entityIds.push(...p.entityIds);
    for (const k of ['commitment', 'called', 'uncalled', 'distributed', 'fees', 'paidIn', 'nav', 'paidInBase', 'distributedBase'] as const) h[k] += p[k];
    h.flowsLocal.push(...p.flowsLocal);
    h.flowsBase.push(...p.flowsBase);
    h.navEstimated ||= p.navEstimated;
    if (p.navReportDate && (!h.navReportDate || p.navReportDate < h.navReportDate)) h.navReportDate = p.navReportDate;
  }
  h.calledPct = h.commitment > EPS ? 1 - h.uncalled / h.commitment : null;
  finishPe(h, asOf);
  return h;
}

/** IRR i SEK för en hel PE-portfölj (fonder i olika valutor). */
export function portfolioIrrBase(parts: PeWork[], asOf: string): number | null {
  const flows = parts.flatMap((p) => p.flowsBase);
  const nav = parts.reduce((a, p) => a + p.navBase, 0);
  return xirr([...flows, { date: asOf, amount: nav }]);
}

export function stripPe(h: PeWork): PeHolding {
  const { flowsLocal: _a, flowsBase: _b, ...rest } = h;
  return rest;
}

// ---------------------------------------------------------------------------
// Portföljnivå
// ---------------------------------------------------------------------------

export interface PortfolioData {
  instruments: Instrument[];
  transactions: Transaction[];
  market: Market;
}

export interface PortfolioSnapshot {
  asOf: string;
  listed: ListedHolding[];
  pe: PeHolding[];
}

function groupTx(txs: Transaction[]) {
  const m = new Map<number, Map<number, Transaction[]>>();
  for (const t of txs) {
    let byEnt = m.get(t.instrument_id);
    if (!byEnt) m.set(t.instrument_id, (byEnt = new Map()));
    let arr = byEnt.get(t.entity_id);
    if (!arr) byEnt.set(t.entity_id, (arr = []));
    arr.push(t);
  }
  return m;
}

/** Alla innehav per datum, aggregerade per instrument över valda juridiska enheter. */
export function snapshot(data: PortfolioData, asOf: string, opts: { includeClosed?: boolean } = {}): PortfolioSnapshot {
  const grouped = groupTx(data.transactions);
  const listed: ListedHolding[] = [];
  const pe: PeHolding[] = [];
  for (const ins of data.instruments) {
    const byEnt = grouped.get(ins.id);
    if (!byEnt) continue;
    if (ins.type === 'PE_FUND') {
      const parts = [...byEnt].map(([e, txs]) => peHolding(ins, e, txs, data.market, asOf)).filter((p) => p.commitment > 0 || p.paidIn > 0);
      if (!parts.length) continue;
      const s = parts.length === 1 ? parts[0] : sumPe(parts, asOf);
      if (opts.includeClosed || s.nav > EPS || s.uncalled > EPS) pe.push(stripPe(s));
    } else {
      const parts = [...byEnt].map(([e, txs]) => listedHolding(ins, e, txs, data.market, asOf)).filter((p) => p.quantity > EPS || p.realizedBase !== 0 || p.dividendsBase !== 0);
      if (!parts.length) continue;
      const s = sumListed(parts);
      if (opts.includeClosed || s.quantity > EPS) listed.push(s);
    }
  }
  return { asOf, listed, pe };
}

/** Portföljens värde i SEK. NaN om något innehav saknar valutakurs – används där ett ofullständigt värde vore fel (TWR). */
export function totalValue(s: PortfolioSnapshot) {
  return s.listed.reduce((a, h) => a + h.mvBase, 0) + s.pe.reduce((a, h) => a + h.navBase, 0);
}

/** Summa av de innehav som kan värderas, och de som inte kan det (saknad valutakurs). */
export function valuedTotal(s: PortfolioSnapshot) {
  const unvalued: (ListedHolding | PeHolding)[] = [];
  let value = 0;
  for (const h of s.listed) if (isFinite(h.mvBase)) value += h.mvBase; else unvalued.push(h);
  for (const h of s.pe) if (isFinite(h.navBase)) value += h.navBase; else unvalued.push(h);
  return { value, unvalued };
}

/** Summerar och hoppar över NaN (innehav utan valutakurs). */
export const sumFinite = <T>(a: T[], f: (x: T) => number) => a.reduce((x, y) => { const v = f(y); return isFinite(v) ? x + v : x; }, 0);

/** Kassaflöde in i portföljen (SEK) för en transaktion – positivt = kapital tillförs värdepappersportföljen. */
export function externalFlow(t: Transaction): number {
  switch (t.type) {
    case 'BUY': return (t.amount + t.fee) * t.fx_rate;
    case 'SELL': return -(t.amount - t.fee) * t.fx_rate;
    case 'DIVIDEND': return -(t.amount - t.fee) * t.fx_rate;
    case 'FEE': return (t.amount + t.fee) * t.fx_rate;
    case 'CALL': return (t.amount + t.fee) * t.fx_rate;
    case 'DISTRIBUTION': return -(t.amount - t.fee) * t.fx_rate;
    default: return 0;
  }
}

// ---------------------------------------------------------------------------
// Tidsserie och tidsviktad avkastning
// ---------------------------------------------------------------------------

export function addDays(d: string, n: number) {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

export function seriesDates(from: string, to: string, stepDays: number): string[] {
  const out: string[] = [];
  for (let d = from; d < to; d = addDays(d, stepDays)) out.push(d);
  out.push(to);
  return out;
}

/**
 * Värdeserie med exakt tidsviktad avkastning: perioden bryts vid varje transaktionsdag så att
 * kassaflöden alltid ligger i periodens slut (r = (V1 − F − V0) / V0). Det undviker Modified Dietz
 * felkällor när ett innehav startar mitt i en period. Endast rutnätsdatum returneras.
 */
export function valueSeries(data: PortfolioData, from: string, to: string, stepDays = 7): SeriesPoint[] {
  const grid = seriesDates(from, to, stepDays);
  const gridSet = new Set(grid);
  const txs = [...data.transactions].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
  const breaks = new Set(grid);
  for (const t of txs) if (t.trade_date > from && t.trade_date <= to) breaks.add(t.trade_date);
  const dates = [...breaks].sort();
  const points: SeriesPoint[] = [];
  let ti = 0;
  let netInvested = 0;
  while (ti < txs.length && txs[ti].trade_date <= dates[0]) netInvested += externalFlow(txs[ti++]);
  let index = 100;
  let prevValue = totalValue(snapshot(data, dates[0]));
  points.push({ date: dates[0], value: prevValue, netInvested, index: isFinite(prevValue) ? index : NaN, complete: isFinite(prevValue), invested: false });
  // Sedan föregående rutnätspunkt: kunde alla delperioder beräknas, och fanns det kapital att avkasta?
  let complete = true;
  let invested = false;
  for (let i = 1; i < dates.length; i++) {
    const d1 = dates[i];
    let flow = 0;
    while (ti < txs.length && txs[ti].trade_date <= d1) flow += externalFlow(txs[ti++]);
    netInvested += flow;
    const value = totalValue(snapshot(data, d1));
    if (!isFinite(value) || !isFinite(prevValue)) complete = false; // saknad valutakurs: avkastningen är okänd, inte 0
    else if (prevValue > EPS) {
      index *= 1 + (value - flow - prevValue) / prevValue;
      invested = true;
    }
    if (gridSet.has(d1)) {
      points.push({ date: d1, value, netInvested, index: isFinite(value) ? index : NaN, complete, invested });
      complete = true;
      invested = false;
    }
    prevValue = value;
  }
  return points;
}

/** Avkastning för standardperioder ur en indexserie. */
export function periodReturns(series: SeriesPoint[], asOf: string): PeriodReturn[] {
  const y = asOf.slice(0, 4);
  const back = (months: number) => {
    const d = new Date(asOf + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - months);
    return d.toISOString().slice(0, 10);
  };
  const defs = [
    { key: '1M', label: '1 mån', from: back(1) },
    { key: '3M', label: '3 mån', from: back(3) },
    { key: 'YTD', label: 'I år', from: `${Number(y) - 1}-12-31` },
    { key: '1Y', label: '1 år', from: back(12) },
    { key: '3Y', label: '3 år', from: back(36) },
    { key: 'ALL', label: 'Sedan start', from: series[0]?.date ?? asOf },
  ];
  const last = series[series.length - 1];
  return defs.map((d) => {
    if (!last || d.from < series[0].date) return { ...d, value: null };
    let base = series[0];
    for (const p of series) if (p.date <= d.from) base = p; else break;
    const within = series.filter((p) => p.date > base.date && p.date <= last.date);
    // Ingen avkastning om perioden saknar innehav (tom portfölj) eller om något värde inte kunde beräknas
    if (!within.length || within.some((p) => p.complete === false) || !within.some((p) => p.invested !== false)) return { ...d, value: null };
    return { ...d, value: base.index > 0 && isFinite(base.index) && isFinite(last.index) ? last.index / base.index - 1 : null };
  });
}

// ---------------------------------------------------------------------------
// Allokering
// ---------------------------------------------------------------------------

export function allocate(items: { key: string; value: number }[]): AllocationRow[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.key, (m.get(i.key) ?? 0) + i.value);
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  return [...m]
    .map(([key, value]) => ({ key, value, share: total ? value / total : 0 }))
    .sort((a, b) => b.value - a.value);
}

// ---------------------------------------------------------------------------
// Kassaflödesprognos för slutna fonder – Takahashi & Alexander (2002), Yale-modellen
//   Anrop:       C_t = RC_t × outnyttjat åtagande
//   Utdelningar: D_t = RD_t × NAV_{t-1} × (1 + G),  RD_t = max(Y, (ålder/L)^B)
//   NAV:         NAV_t = NAV_{t-1} × (1 + G) + C_t − D_t
// ---------------------------------------------------------------------------

export interface TaParams { growth: number; life: number; bow: number; yield: number; rc: number[] }

export const TA_DEFAULTS: Record<string, TaParams> = {
  Buyout: { growth: 0.12, life: 12, bow: 2.5, yield: 0, rc: [0.25, 0.333, 0.5] },
  Growth: { growth: 0.13, life: 12, bow: 2.5, yield: 0, rc: [0.25, 0.333, 0.5] },
  Venture: { growth: 0.14, life: 13, bow: 2.8, yield: 0, rc: [0.2, 0.25, 0.333, 0.5] },
  Secondaries: { growth: 0.11, life: 10, bow: 2.0, yield: 0.05, rc: [0.4, 0.5, 0.5] },
  Infrastruktur: { growth: 0.08, life: 15, bow: 1.5, yield: 0.04, rc: [0.25, 0.333, 0.5] },
  Fastigheter: { growth: 0.08, life: 10, bow: 1.8, yield: 0.03, rc: [0.3, 0.4, 0.5] },
  default: { growth: 0.1, life: 12, bow: 2.5, yield: 0, rc: [0.25, 0.333, 0.5] },
};

export interface TaYear { year: number; calls: number; distributions: number; nav: number; uncalled: number }

/** Prognos per kalenderår från och med året efter asOf. Belopp i samma valuta som indata. */
export function taForecast(p: { vintage: number; nav: number; uncalled: number; asOfYear: number; years: number; params: TaParams }): TaYear[] {
  const out: TaYear[] = [];
  let nav = p.nav;
  let unc = p.uncalled;
  for (let k = 1; k <= p.years; k++) {
    const year = p.asOfYear + k;
    const age = Math.max(1, year - p.vintage + 1);
    const rc = p.params.rc[Math.min(age - 1, p.params.rc.length - 1)];
    const calls = unc * rc;
    const rd = Math.min(1, Math.max(p.params.yield, Math.pow(Math.min(age, p.params.life) / p.params.life, p.params.bow)));
    const grown = nav * (1 + p.params.growth);
    const dist = age >= p.params.life ? grown : grown * rd;
    nav = Math.max(0, grown + calls - dist);
    unc = Math.max(0, unc - calls);
    out.push({ year, calls, distributions: dist, nav, uncalled: unc });
  }
  return out;
}
