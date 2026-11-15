import { HttpError } from './auth.ts';
import { all, get, run } from './db.ts';
import { FX_TRADE_MAX_DAYS, findOversell } from './calc.ts';
import { getMarket } from './data.ts';
import { ASSET_CLASSES, LISTED_TX_TYPES, PE_TX_TYPES, suggestAssetClass, type AssetClass, type Instrument, type InstrumentType, type Transaction, type TxType } from '../shared/types.ts';

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const num = (v: unknown, field: string, opts: { min?: number; optional?: boolean; def?: number } = {}) => {
  if ((v === undefined || v === null || v === '') && (opts.optional || opts.def !== undefined)) return opts.def ?? null;
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : Number(v);
  if (!isFinite(n)) throw new HttpError(400, `${field}: ogiltigt tal`);
  if (opts.min !== undefined && n < opts.min) throw new HttpError(400, `${field}: får inte vara mindre än ${opts.min}`);
  return n;
};
const str = (v: unknown, max = 200) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

const fmtQ = (n: number) => n.toLocaleString('sv-SE', { maximumFractionDigits: 4 });

/**
 * Kontrollerar att innehavet aldrig blir negativt över hela tidslinjen för en enhet och ett instrument,
 * efter att transaktionerna i `remove` tagits bort och `add` lagts till. Kastar 400 med förklaring.
 */
export function assertPositions(entityId: number, instrumentId: number, change: { remove?: number[]; add?: Pick<Transaction, 'trade_date' | 'type' | 'id' | 'quantity'>[] }, prefix = '') {
  const rm = new Set(change.remove ?? []);
  const txs = all<Transaction>("SELECT id, trade_date, type, quantity FROM transactions WHERE entity_id=? AND instrument_id=? AND type IN ('BUY','SELL')", entityId, instrumentId)
    .filter((t) => !rm.has(t.id));
  const bad = findOversell([...txs, ...(change.add ?? [])]);
  if (bad) throw new HttpError(400, `${prefix}Försäljningen ${bad.date} (${fmtQ(bad.quantity)} st) överstiger innehavet (${fmtQ(bad.held)} st) per den dagen`);
}

/** Meddelande när valutakurs inte kan hämtas automatiskt för en affär. */
export function fxMissingMessage(currency: string, date: string) {
  const m = getMarket();
  const prev = m.fxAsOf(currency, date);
  const first = m.fxFirstDate(currency);
  const why = prev ? `senaste registrerade kurs är från ${prev.date}, mer än ${FX_TRADE_MAX_DAYS} dagar före affärsdagen`
    : first ? `första registrerade kurs är från ${first}, efter affärsdagen` : 'ingen kurs är registrerad';
  return `Valutakurs ${currency} per ${date} saknas (${why}) – ange kursen manuellt`;
}

/**
 * Validerar och normaliserar en transaktion.
 *  - Kapitalanrop: `amount` är TOTALT anropat belopp (som på avin) och `fee` varav avgifter. Lagras som
 *    amount = investeringsdel (total − avgifter) och fee = avgifter.
 *  - Valutakurs som inte anges hämtas från registrerade kurser högst 7 dagar före affärsdagen, aldrig senare.
 *  - Köp och försäljningar kontrolleras mot innehavet över hela tidslinjen (`replaceId` = transaktion som ersätts).
 */
export function validateTransaction(b: Record<string, unknown>, opts: { replaceId?: number; skipPositions?: boolean } = {}) {
  const instrument = get<Instrument>('SELECT * FROM instruments WHERE id = ?', Number(b.instrument_id));
  if (!instrument) throw new HttpError(400, 'Okänt instrument');
  if (!get('SELECT 1 FROM entities WHERE id = ?', Number(b.entity_id))) throw new HttpError(400, 'Okänd juridisk enhet');
  const type = String(b.type) as TxType;
  const allowed = instrument.type === 'PE_FUND' ? PE_TX_TYPES : LISTED_TX_TYPES;
  if (!allowed.includes(type)) throw new HttpError(400, `Transaktionstypen ${type} är inte tillåten för ${instrument.name}`);
  if (!isDate(b.trade_date)) throw new HttpError(400, 'Affärsdag saknas eller är ogiltig (ÅÅÅÅ-MM-DD)');
  const settle = b.settle_date ? (isDate(b.settle_date) ? (b.settle_date as string) : null) : null;
  let quantity = 0;
  let price = 0;
  let amount: number;
  if (type === 'BUY' || type === 'SELL') {
    quantity = num(b.quantity, 'Antal', { min: 0 })!;
    if (quantity <= 0) throw new HttpError(400, 'Antal måste vara större än 0');
    price = num(b.price, 'Kurs', { min: 0 })!;
    amount = num(b.amount, 'Belopp', { min: 0, optional: true }) ?? quantity * price;
  } else {
    amount = num(b.amount, 'Belopp', { min: 0 })!;
    price = num(b.price, 'Kurs', { min: 0, def: 0 })!;
  }
  if (amount <= 0) throw new HttpError(400, 'Belopp måste vara större än 0');
  const fee = type === 'COMMITMENT' ? 0 : num(b.fee, 'Avgift', { min: 0, def: 0 })!;
  let outside = 0;
  let recallable = 0;
  if (type === 'CALL') {
    if (fee > amount + 1e-9) throw new HttpError(400, `Avgifterna (${fmtQ(fee)}) kan inte vara större än det totala anropade beloppet (${fmtQ(amount)})`);
    outside = num(b.outside_commitment, 'Utjämningsränta', { min: 0, def: 0 })!;
    if (outside > amount + 1e-9) throw new HttpError(400, 'Utjämningsräntan kan inte vara större än det totala anropade beloppet');
  }
  if (type === 'DISTRIBUTION') {
    recallable = num(b.recallable, 'Återinkallningsbart', { min: 0, def: 0 })!;
    if (recallable > amount + 1e-9) throw new HttpError(400, 'Återinkallningsbart belopp kan inte vara större än utdelningen');
  }
  let fx = num(b.fx_rate, 'Valutakurs', { min: 0, optional: true });
  let fxDate: string | null = null;
  if (!fx) {
    const r = getMarket().fxForTrade(instrument.currency, b.trade_date as string);
    if (!r) throw new HttpError(400, fxMissingMessage(instrument.currency, b.trade_date as string));
    fx = r.value;
    fxDate = instrument.currency === 'SEK' ? null : r.date;
  }
  if ((type === 'BUY' || type === 'SELL') && !opts.skipPositions) {
    assertPositions(Number(b.entity_id), instrument.id, {
      remove: opts.replaceId ? [opts.replaceId] : [],
      add: [{ id: Number.MAX_SAFE_INTEGER, trade_date: b.trade_date as string, type, quantity }],
    });
  }
  return {
    entity_id: Number(b.entity_id), instrument_id: instrument.id, type, trade_date: b.trade_date as string, settle_date: settle,
    quantity, price,
    // Kapitalanrop lagras som investeringsdel + avgifter
    amount: type === 'CALL' ? amount - fee : amount,
    fee, fx_rate: fx, fx_date: fxDate, note: str(b.note, 500), outside_commitment: outside, recallable,
  };
}

/** Sparar en validerad transaktion. */
export function insertTransaction(v: ReturnType<typeof validateTransaction>, userId: number | null, extra: { document_id?: number | null; details?: string | null } = {}) {
  const r = run(
    'INSERT INTO transactions (entity_id,instrument_id,type,trade_date,settle_date,quantity,price,amount,fee,fx_rate,note,created_by,outside_commitment,recallable,document_id,details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    v.entity_id, v.instrument_id, v.type, v.trade_date, v.settle_date, v.quantity, v.price, v.amount, v.fee, v.fx_rate, v.note, userId, v.outside_commitment, v.recallable,
    extra.document_id ?? null, extra.details ?? null,
  );
  return Number(r.lastInsertRowid);
}

/** Beloppet som visas och tas emot i formulär, listor, import och export: för kapitalanrop det totala anropade beloppet. */
export const displayAmount = (t: Pick<Transaction, 'type' | 'amount' | 'fee'>) => (t.type === 'CALL' ? t.amount + t.fee : t.amount);

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
