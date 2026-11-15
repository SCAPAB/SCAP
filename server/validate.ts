import { HttpError } from './auth.ts';
import { get } from './db.ts';
import { getMarket } from './data.ts';
import { LISTED_TX_TYPES, PE_TX_TYPES, type Instrument, type InstrumentType, type TxType } from '../shared/types.ts';

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const num = (v: unknown, field: string, opts: { min?: number; optional?: boolean; def?: number } = {}) => {
  if ((v === undefined || v === null || v === '') && (opts.optional || opts.def !== undefined)) return opts.def ?? null;
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : Number(v);
  if (!isFinite(n)) throw new HttpError(400, `${field}: ogiltigt tal`);
  if (opts.min !== undefined && n < opts.min) throw new HttpError(400, `${field}: får inte vara mindre än ${opts.min}`);
  return n;
};
const str = (v: unknown, max = 200) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

export function validateTransaction(b: Record<string, unknown>) {
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
  const fee = num(b.fee, 'Avgift', { min: 0, def: 0 })!;
  let fx = num(b.fx_rate, 'Valutakurs', { min: 0, optional: true });
  if (!fx) {
    fx = getMarket().fxRate(instrument.currency, b.trade_date as string);
    if (!isFinite(fx)) throw new HttpError(400, `Valutakurs för ${instrument.currency} saknas – ange den manuellt`);
  }
  if (type === 'SELL') {
    const held = get<{ q: number }>(
      "SELECT COALESCE(SUM(CASE type WHEN 'BUY' THEN quantity WHEN 'SELL' THEN -quantity END),0) q FROM transactions WHERE entity_id=? AND instrument_id=? AND trade_date<=? AND id != ?",
      Number(b.entity_id), instrument.id, b.trade_date, Number(b.id ?? 0),
    )!.q;
    if (quantity > held + 1e-9) throw new HttpError(400, `Försäljningen (${quantity}) överstiger innehavet (${held}) per ${b.trade_date}`);
  }
  return {
    entity_id: Number(b.entity_id), instrument_id: instrument.id, type, trade_date: b.trade_date as string, settle_date: settle,
    quantity, price, amount, fee, fx_rate: fx, note: str(b.note, 500),
  };
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
  return {
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
}

export { isDate, num, str };
