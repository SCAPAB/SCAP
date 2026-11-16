import { HttpError } from './auth.ts';
import { all, get } from './db.ts';
import { getMarket } from './data.ts';
import { sortTx } from './calc.ts';
import { ASSET_CLASSES, LISTED_TX_TYPES, PE_TX_TYPES, suggestAssetClass, type AssetClass, type Instrument, type InstrumentType, type TxType } from '../shared/types.ts';

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const num = (v: unknown, field: string, opts: { min?: number; optional?: boolean; def?: number } = {}) => {
  if ((v === undefined || v === null || v === '') && (opts.optional || opts.def !== undefined)) return opts.def ?? null;
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : Number(v);
  if (!isFinite(n)) throw new HttpError(400, `${field}: ogiltigt tal`);
  if (opts.min !== undefined && n < opts.min) throw new HttpError(400, `${field}: får inte vara mindre än ${opts.min}`);
  return n;
};
const str = (v: unknown, max = 200) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const fmtQ = (n: number, d = 4) => n.toLocaleString('sv-SE', { maximumFractionDigits: d });

// ---------------------------------------------------------------------------
// Innehavet över hela tidslinjen (F4)
// ---------------------------------------------------------------------------

/** En post i tidslinjen. Utan id räknas posten som den senast registrerade. */
export interface TimelineTx {
  id?: number; type: TxType | string; trade_date: string;
  quantity?: number; amount?: number; fee?: number; outside_commitment?: number | null; recallable?: number | null;
}
/** Ändringen som prövas: ny post, ersättning av en befintlig (även med annat datum eller annan typ) eller borttag. */
export type TimelineChange = { add: TimelineTx } | { replace: number; with: TimelineTx } | { remove: number };

const NEW_ID = Number.MAX_SAFE_INTEGER;

/** Tillämpar en ändring på en lista med poster. */
function applyChange<T extends { id?: number }>(rows: T[], change: TimelineChange | undefined, toRow: (t: TimelineTx) => T): T[] {
  if (!change) return rows;
  if ('add' in change) return [...rows, toRow(change.add)];
  if ('replace' in change) return [...rows.filter((r) => r.id !== change.replace), toRow({ ...change.with, id: change.with.id ?? change.replace })];
  return rows.filter((r) => r.id !== change.remove);
}

/**
 * Spelar upp instrumentets alla köp och försäljningar för en juridisk enhet i datumordning (köp före
 * försäljning samma dag, därefter id), efter att ändringen har tillämpats. Returnerar ett felmeddelande
 * för den första försäljning som överstiger innehavet, annars null. Läser med SQL så att den fungerar
 * inne i importens databastransaktion.
 */
export function checkHoldingTimeline(entityId: number, instrumentId: number, change?: TimelineChange): string | null {
  const rows = all<{ id: number; type: string; trade_date: string; quantity: number }>(
    "SELECT id, type, trade_date, quantity FROM transactions WHERE entity_id=? AND instrument_id=? AND type IN ('BUY','SELL')", entityId, instrumentId,
  );
  const txs = applyChange(rows, change, (t) => ({ id: t.id ?? NEW_ID, type: t.type, trade_date: t.trade_date, quantity: t.quantity ?? 0 }))
    .filter((t) => t.type === 'BUY' || t.type === 'SELL') as { id: number; type: TxType; trade_date: string; quantity: number }[];
  let q = 0;
  for (const t of sortTx(txs)) {
    if (t.type === 'BUY') q += t.quantity;
    else {
      if (t.quantity > q + 1e-9) return `Försäljningen ${t.trade_date} (${fmtQ(t.quantity)}) överstiger innehavet (${fmtQ(Math.max(0, q))}) per ${t.trade_date}`;
      q -= t.quantity;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Åtagandet över hela tidslinjen (F5)
// ---------------------------------------------------------------------------

/**
 * Vid varje kapitalanrop i datumordning ska dragningen hittills, summan av (belopp + avgift − utanför
 * åtagandet), vara högst åtaganden t.o.m. dagen plus återinkallningsbara utdelningar t.o.m. dagen,
 * med toleransen 1 valutaenhet. Returnerar ett felmeddelande för det första anrop som överstiger
 * outnyttjat åtagande efter att ändringen har tillämpats, annars null.
 */
export function checkCommitmentTimeline(entityId: number, instrumentId: number, change?: TimelineChange): string | null {
  const ccy = get<{ currency: string }>('SELECT currency FROM instruments WHERE id=?', instrumentId)?.currency ?? '';
  type Row = { id: number; type: string; trade_date: string; amount: number; fee: number; outside_commitment: number; recallable: number };
  const rows = all<Row>(
    "SELECT id, type, trade_date, amount, fee, outside_commitment, recallable FROM transactions WHERE entity_id=? AND instrument_id=? AND type IN ('COMMITMENT','CALL','DISTRIBUTION')",
    entityId, instrumentId,
  );
  const txs = applyChange<Row>(rows, change, (t) => ({
    id: t.id ?? NEW_ID, type: t.type, trade_date: t.trade_date, amount: t.amount ?? 0, fee: t.fee ?? 0,
    outside_commitment: t.outside_commitment ?? 0, recallable: t.recallable ?? 0,
  })).sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.id - b.id);
  let drawn = 0;
  for (const c of txs) {
    if (c.type !== 'CALL') continue;
    const draw = c.amount + c.fee - (c.outside_commitment ?? 0);
    drawn += draw;
    const capacity = txs.filter((t) => t.trade_date <= c.trade_date).reduce((a, t) => a + (t.type === 'COMMITMENT' ? t.amount : t.type === 'DISTRIBUTION' ? t.recallable ?? 0 : 0), 0);
    if (drawn > capacity + 1) {
      const available = capacity - (drawn - draw);
      const later = txs.find((t) => t.type === 'COMMITMENT' && t.trade_date > c.trade_date);
      return `Kapitalanropet (${fmtQ(draw, 2)} ${ccy}) överstiger outnyttjat åtagande (${fmtQ(available, 2)} ${ccy}) per ${c.trade_date}`
        + (later ? `. Åtagandet är registrerat först ${later.trade_date} – kontrollera datumet på åtagandet.` : '');
    }
  }
  return null;
}

/** Befintliga data som bryter mot reglerna (visas under Administration → Datakontroll). */
export interface IntegrityIssue { kind: 'holding' | 'commitment'; entity_id: number; entity: string; instrument_id: number; instrument: string; date: string | null; message: string }

export function integrityIssues(): IntegrityIssue[] {
  const out: IntegrityIssue[] = [];
  const pairs = all<{ entity_id: number; entity: string; instrument_id: number; instrument: string; type: string }>(
    `SELECT DISTINCT t.entity_id, e.name entity, t.instrument_id, i.name instrument, i.type FROM transactions t
     JOIN entities e ON e.id=t.entity_id JOIN instruments i ON i.id=t.instrument_id ORDER BY i.name, e.name`,
  );
  for (const p of pairs) {
    const kind = p.type === 'PE_FUND' ? 'commitment' : 'holding';
    const msg = kind === 'commitment' ? checkCommitmentTimeline(p.entity_id, p.instrument_id) : checkHoldingTimeline(p.entity_id, p.instrument_id);
    if (msg) out.push({ kind, entity_id: p.entity_id, entity: p.entity, instrument_id: p.instrument_id, instrument: p.instrument, date: msg.match(/per (\d{4}-\d{2}-\d{2})/)?.[1] ?? null, message: msg });
  }
  return out;
}

/** En validerad och normaliserad transaktion, redo att sparas. */
export interface ValidTx {
  entity_id: number; instrument_id: number; type: TxType; trade_date: string; settle_date: string | null;
  quantity: number; price: number; amount: number; fee: number; fx_rate: number; note: string | null;
  outside_commitment: number; recallable: number;
}
export interface TxCheck { value: ValidTx | null; errors: string[]; codes: string[] }

/** Tolkar ett tal utan att kasta: null om det saknas, NaN om det är ogiltigt. Decimalkomma och mellanslag går bra. */
const parseNum = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  return typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : Number(v);
};

/**
 * Samma kontroller för alla vägar in: Ny transaktion, Transaktioner (ändring), Import, Inkorgen och
 * ändringsbegäran. Kastar inte, utan samlar alla fel (F10):
 *  - grunddata: instrument, enhet, typ och affärsdag
 *  - tecken: belopp, avgift, antal, kurs, valutakurs, utanför åtagandet och återinkallningsbart ≥ 0
 *  - kapitalanrop: utanför åtagandet ≤ avgiften (amount är investeringsdelen och får inte vara negativ)
 *  - valutakurs på eller före affärsdagen (F3)
 *  - innehavet över hela tidslinjen (F4) och åtagandet över hela tidslinjen (F5)
 * `b.id` anger en befintlig transaktion som ersätts (ändring), så att tidslinjen prövas med den nya versionen.
 */
export function checkTransaction(b: Record<string, unknown>): TxCheck {
  const errors: string[] = [];
  const codes: string[] = [];
  const fail = (code: string, msg: string) => { errors.push(msg); codes.push(code); };
  const instrument = get<Instrument>('SELECT * FROM instruments WHERE id = ?', Number(b.instrument_id));
  if (!instrument) fail('instrument', 'Okänt instrument');
  if (!get('SELECT 1 FROM entities WHERE id = ?', Number(b.entity_id))) fail('entity', 'Okänd juridisk enhet');
  const type = String(b.type) as TxType;
  if (instrument && !(instrument.type === 'PE_FUND' ? PE_TX_TYPES : LISTED_TX_TYPES).includes(type)) {
    fail('type', `Transaktionstypen ${type} är inte tillåten för ${instrument.name}`);
  }
  const dateOk = isDate(b.trade_date);
  if (!dateOk) fail('date', 'Affärsdag saknas eller är ogiltig (ÅÅÅÅ-MM-DD)');
  const settle = b.settle_date ? (isDate(b.settle_date) ? (b.settle_date as string) : null) : null;

  // Tal: ogiltiga tal och negativa värden
  const field = (v: unknown, label: string, code: string) => {
    const n = parseNum(v);
    if (n === null) return null;
    if (!isFinite(n)) fail(code, `${label}: ogiltigt tal`);
    else if (n < 0) fail('sign', `${label} får inte vara negativt`);
    return n;
  };
  const qIn = field(b.quantity, 'Antal', 'quantity');
  const pIn = field(b.price, 'Kurs', 'price');
  const aIn = field(b.amount, 'Belopp', 'amount');
  const fIn = field(b.fee, 'Avgift', 'fee');
  const fxIn = field(b.fx_rate, 'Valutakurs', 'fx');
  const oIn = field(b.outside_commitment, 'Varav utanför åtagandet', 'outside');
  const rIn = field(b.recallable, 'Varav återinkallningsbart', 'recallable');

  let quantity = 0;
  let price = 0;
  let amount: number;
  if (type === 'BUY' || type === 'SELL') {
    quantity = qIn ?? NaN;
    price = pIn ?? NaN;
    if (qIn === null) fail('quantity', 'Antal saknas');
    else if (qIn === 0) fail('quantity', 'Antal måste vara större än 0');
    if (pIn === null) fail('price', 'Kurs saknas');
    amount = aIn ?? quantity * price;
  } else {
    amount = aIn ?? NaN;
    price = pIn ?? 0;
    if (aIn === null) fail('amount', 'Belopp saknas');
  }
  const fee = fIn ?? 0;
  if (isFinite(amount) && amount >= 0 && fee >= 0) {
    // Ett kapitalanrop kan bestå av enbart avgifter (investeringsdelen 0)
    if (type === 'CALL' ? amount + fee <= 0 : amount <= 0) fail('amount', 'Belopp måste vara större än 0');
  }
  const outside = type === 'CALL' ? oIn ?? 0 : 0;
  const recallable = type === 'DISTRIBUTION' ? rIn ?? 0 : 0;
  if (type === 'CALL' && outside > fee + 1e-9 && fee >= 0) {
    fail('outside', `Varav utanför åtagandet (${fmtQ(outside, 2)}) kan inte vara större än avgiften (${fmtQ(fee, 2)})`);
  }
  let fx = fxIn != null && fxIn > 0 ? fxIn : NaN;
  if (!(fxIn != null && fxIn < 0) && !isFinite(fx) && instrument && dateOk) {
    fx = getMarket().fxRate(instrument.currency, b.trade_date as string);
    if (!isFinite(fx)) fail('fx', `Valutakurs för ${instrument.currency} saknas – ange den manuellt`);
  }

  // Tidslinjen prövas bara när uppgifterna i sig är giltiga
  if (!errors.length && instrument) {
    const me = { type, trade_date: b.trade_date as string, quantity, amount, fee, outside_commitment: outside, recallable };
    const change: TimelineChange = b.id ? { replace: Number(b.id), with: me } : { add: me };
    if (instrument.type !== 'PE_FUND' && (type === 'BUY' || type === 'SELL' || b.id)) {
      const msg = checkHoldingTimeline(Number(b.entity_id), instrument.id, change);
      if (msg) fail('holding', msg);
    }
    if (instrument.type === 'PE_FUND' && (type === 'CALL' || type === 'COMMITMENT' || type === 'DISTRIBUTION' || b.id)) {
      const msg = checkCommitmentTimeline(Number(b.entity_id), instrument.id, change);
      if (msg) fail('commitment', msg);
    }
  }
  const value: ValidTx | null = errors.length || !instrument ? null : {
    entity_id: Number(b.entity_id), instrument_id: instrument.id, type, trade_date: b.trade_date as string, settle_date: settle,
    quantity, price, amount, fee, fx_rate: fx, note: str(b.note, 500), outside_commitment: outside, recallable,
  };
  return { value, errors, codes };
}

/** Validerar och normaliserar en transaktion. Kastar 400 med det första felet (se checkTransaction). */
export function validateTransaction(b: Record<string, unknown>): ValidTx {
  const r = checkTransaction(b);
  if (r.errors.length || !r.value) throw new HttpError(400, r.errors[0] ?? 'Ogiltig transaktion');
  return r.value;
}

const TYPES: InstrumentType[] = ['EQUITY', 'FUND', 'PE_FUND'];
export function validateInstrument(b: Record<string, unknown>) {
  const type = String(b.type) as InstrumentType;
  if (!TYPES.includes(type)) throw new HttpError(400, 'Ogiltig instrumenttyp');
  const name = str(b.name);
  if (!name) throw new HttpError(400, 'Namn krävs');
  const currency = str(b.currency, 3)?.toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'Valuta anges som ISO-kod, t.ex. SEK');
  const isin = str(b.isin, 12)?.toUpperCase() ?? null;
  if (isin && !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) throw new HttpError(400, 'Ogiltigt ISIN-format');
  const base = {
    type, name, isin, currency,
    ticker: str(b.ticker, 30),
    country: str(b.country, 2)?.toUpperCase() ?? null,
    region: str(b.region, 50),
    sector: str(b.sector, 80),
    fund_category: str(b.fund_category, 50),
    manager: str(b.manager, 120),
    strategy: str(b.strategy, 50),
    vintage: num(b.vintage, 'Vintage', { optional: true, min: 1950 }),
  };
  const suggested = suggestAssetClass(base);
  const ac = str(b.asset_class, 30) as AssetClass | null;
  if (ac && !ASSET_CLASSES.some((a) => a.key === ac)) throw new HttpError(400, 'Okänt tillgångsslag');
  return { ...base, asset_class: ac ?? suggested.asset_class, sub_class: str(b.sub_class, 50) ?? (ac && ac !== suggested.asset_class ? null : suggested.sub_class) };
}

export { isDate, num, str };
