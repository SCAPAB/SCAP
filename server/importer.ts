/**
 * CSV-import med förhandsgranskning. Hela filen körs i en databastransaktion;
 * vid testkörning (dryRun) eller om någon rad har fel rullas allt tillbaka – allt eller inget.
 */
import Papa from 'papaparse';
import { db, all, run } from './db.ts';
import { HttpError } from './auth.ts';
import { validateInstrument, validateTransaction, isDate, num } from './validate.ts';
import type { Entity, Instrument, TxType } from '../shared/types.ts';

export const IMPORT_KINDS = {
  transactions: {
    label: 'Transaktioner',
    columns: ['datum', 'enhet', 'instrument', 'typ', 'antal', 'kurs', 'belopp', 'avgift', 'valutakurs', 'likviddag', 'notering'],
    example: 'datum;enhet;instrument;typ;antal;kurs;belopp;avgift;valutakurs;notering\n2026-01-15;;SE0000115446;Köp;1000;245,50;245500;98;;Köp via mäklare',
  },
  prices: { label: 'Kurser', columns: ['instrument', 'datum', 'kurs'], example: 'instrument;datum;kurs\nSE0000115446;2026-01-15;246,10' },
  fx: { label: 'Valutakurser', columns: ['valuta', 'datum', 'kurs'], example: 'valuta;datum;kurs\nEUR;2026-01-15;11,02' },
  valuations: { label: 'NAV PE-fonder', columns: ['enhet', 'instrument', 'datum', 'nav'], example: 'instrument;datum;nav\nExempel Buyout Fund IV;2025-12-31;14250000' },
  instruments: {
    label: 'Instrument',
    columns: ['typ', 'namn', 'isin', 'ticker', 'valuta', 'land', 'region', 'bransch', 'kategori', 'förvaltare', 'strategi', 'vintage'],
    example: 'typ;namn;isin;ticker;valuta;land;region;bransch;kategori;förvaltare;strategi;vintage\nAktie;Sandvik;SE0000667891;SAND;SEK;SE;Norden;Industri;;;;',
  },
} as const;

const ALIASES: Record<string, string> = {
  date: 'datum', trade_date: 'datum', affärsdag: 'datum', entity: 'enhet', juridisk_enhet: 'enhet', isin: 'isin', type: 'typ',
  quantity: 'antal', price: 'kurs', amount: 'belopp', fee: 'avgift', courtage: 'avgift', fx: 'valutakurs', fx_rate: 'valutakurs',
  settle_date: 'likviddag', note: 'notering', kommentar: 'notering', currency: 'valuta', rate: 'kurs', name: 'namn', country: 'land',
  sector: 'bransch', category: 'kategori', manager: 'förvaltare', strategy: 'strategi', värdepapper: 'instrument',
};
const TX_TYPES: Record<string, TxType> = {
  köp: 'BUY', buy: 'BUY', sälj: 'SELL', sell: 'SELL', försäljning: 'SELL', utdelning: 'DIVIDEND', dividend: 'DIVIDEND',
  avgift: 'FEE', fee: 'FEE', åtagande: 'COMMITMENT', commitment: 'COMMITMENT', kapitalanrop: 'CALL', anrop: 'CALL', call: 'CALL',
  'capital call': 'CALL', återbetalning: 'DISTRIBUTION', distribution: 'DISTRIBUTION', 'utdelning/återbetalning': 'DISTRIBUTION',
};
const INS_TYPES: Record<string, string> = { aktie: 'EQUITY', equity: 'EQUITY', fond: 'FUND', fund: 'FUND', 'pe-fond': 'PE_FUND', pe_fund: 'PE_FUND', pe: 'PE_FUND' };

export interface ImportResult {
  kind: string;
  rows: number;
  inserted: number;
  errors: { row: number; message: string }[];
  preview: Record<string, unknown>[];
  committed: boolean;
}

export function importCsv(kind: string, csv: string, opts: { dryRun: boolean; userId: number | null }): ImportResult {
  if (!(kind in IMPORT_KINDS)) throw new HttpError(400, 'Okänd importtyp');
  if (!csv.trim()) throw new HttpError(400, 'Filen är tom');
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ''), {
    header: true, skipEmptyLines: 'greedy',
    transformHeader: (h) => {
      const k = h.trim().toLowerCase().replace(/\s+/g, '_');
      return ALIASES[k] ?? k;
    },
  });
  const rows = parsed.data;
  if (rows.length > 50_000) throw new HttpError(400, 'Max 50 000 rader per import');

  const entities = all<Entity>('SELECT * FROM entities');
  const instruments = all<Instrument>('SELECT * FROM instruments');
  const findEntity = (v: string | undefined) => {
    const s = (v ?? '').trim();
    if (!s && entities.length === 1) return entities[0]; // en juridisk enhet: kolumnen kan utelämnas
    const e = entities.find((e) => String(e.id) === s || e.name.toLowerCase() === s.toLowerCase() || e.org_nr === s);
    if (!e) throw new Error(`Okänd juridisk enhet "${s}"`);
    return e;
  };
  const findInstrument = (r: Record<string, string>) => {
    const s = (r.instrument ?? r.isin ?? '').trim();
    const i = instruments.find((i) => i.isin?.toUpperCase() === s.toUpperCase() || i.name.toLowerCase() === s.toLowerCase() || (i.ticker && i.ticker.toLowerCase() === s.toLowerCase()) || String(i.id) === s);
    if (!i) throw new Error(`Okänt instrument "${s}"`);
    return i;
  };

  const result: ImportResult = { kind, rows: rows.length, inserted: 0, errors: [], preview: [], committed: false };
  // Transaktioner sorteras på datum så att försäljningar valideras mot innehav som skapas tidigare i filen
  const order = rows.map((r, i) => ({ r, i }));
  if (kind === 'transactions') order.sort((a, b) => (a.r.datum ?? '').localeCompare(b.r.datum ?? ''));

  db.exec('BEGIN');
  try {
    for (const { r, i } of order) {
      const line = i + 2; // rubrikrad = 1
      try {
        let preview: Record<string, unknown>;
        switch (kind) {
          case 'transactions': {
            const e = findEntity(r.enhet);
            const ins = findInstrument(r);
            const type = TX_TYPES[(r.typ ?? '').trim().toLowerCase()] ?? (r.typ ?? '').trim().toUpperCase();
            const v = validateTransaction({
              entity_id: e.id, instrument_id: ins.id, type, trade_date: r.datum?.trim(), settle_date: r.likviddag?.trim(),
              quantity: r.antal, price: r.kurs, amount: r.belopp, fee: r.avgift, fx_rate: r.valutakurs, note: r.notering,
            });
            run('INSERT INTO transactions (entity_id,instrument_id,type,trade_date,settle_date,quantity,price,amount,fee,fx_rate,note,created_by,outside_commitment,recallable) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
              v.entity_id, v.instrument_id, v.type, v.trade_date, v.settle_date, v.quantity, v.price, v.amount, v.fee, v.fx_rate, v.note, opts.userId, v.outside_commitment, v.recallable);
            preview = { rad: line, datum: v.trade_date, enhet: e.name, instrument: ins.name, typ: v.type, antal: v.quantity, kurs: v.price, belopp: v.amount, valuta: ins.currency, valutakurs: v.fx_rate };
            break;
          }
          case 'prices': {
            const ins = findInstrument(r);
            if (ins.type === 'PE_FUND') throw new Error('Använd NAV-import för PE-fonder');
            if (!isDate(r.datum?.trim())) throw new Error('Ogiltigt datum');
            const p = num(r.kurs, 'Kurs', { min: 0 })!;
            run('INSERT INTO prices (instrument_id,date,price,source) VALUES (?,?,?,?) ON CONFLICT(instrument_id,date) DO UPDATE SET price=excluded.price, source=excluded.source', ins.id, r.datum.trim(), p, 'Import');
            preview = { rad: line, instrument: ins.name, datum: r.datum.trim(), kurs: p };
            break;
          }
          case 'fx': {
            const c = (r.valuta ?? '').trim().toUpperCase();
            if (!/^[A-Z]{3}$/.test(c) || c === 'SEK') throw new Error('Ogiltig valuta');
            if (!isDate(r.datum?.trim())) throw new Error('Ogiltigt datum');
            const k = num(r.kurs, 'Kurs', { min: 0 })!;
            run('INSERT INTO fx_rates (currency,date,rate) VALUES (?,?,?) ON CONFLICT(currency,date) DO UPDATE SET rate=excluded.rate', c, r.datum.trim(), k);
            preview = { rad: line, valuta: c, datum: r.datum.trim(), kurs: k };
            break;
          }
          case 'valuations': {
            const e = findEntity(r.enhet);
            const ins = findInstrument(r);
            if (ins.type !== 'PE_FUND') throw new Error('Instrumentet är ingen PE-fond');
            if (!isDate(r.datum?.trim())) throw new Error('Ogiltigt datum');
            const nav = num(r.nav, 'NAV', { min: 0 })!;
            run('INSERT INTO pe_valuations (entity_id,instrument_id,date,nav,source) VALUES (?,?,?,?,?) ON CONFLICT(entity_id,instrument_id,date) DO UPDATE SET nav=excluded.nav, source=excluded.source', e.id, ins.id, r.datum.trim(), nav, 'Import');
            preview = { rad: line, enhet: e.name, instrument: ins.name, datum: r.datum.trim(), nav };
            break;
          }
          case 'instruments': {
            const v = validateInstrument({
              type: INS_TYPES[(r.typ ?? '').trim().toLowerCase()] ?? r.typ, name: r.namn, isin: r.isin, ticker: r.ticker, currency: r.valuta,
              country: r.land, region: r.region, sector: r.bransch, fund_category: r.kategori, manager: r['förvaltare'], strategy: r.strategi, vintage: r.vintage,
            });
            if (v.isin && instruments.some((i) => i.isin === v.isin)) throw new Error(`ISIN ${v.isin} finns redan`);
            const res = run('INSERT INTO instruments (type,name,isin,ticker,currency,country,region,sector,fund_category,manager,strategy,vintage,asset_class,sub_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
              v.type, v.name, v.isin, v.ticker, v.currency, v.country, v.region, v.sector, v.fund_category, v.manager, v.strategy, v.vintage, v.asset_class, v.sub_class);
            instruments.push({ ...v, id: Number(res.lastInsertRowid) } as Instrument);
            preview = { rad: line, typ: v.type, namn: v.name, isin: v.isin, valuta: v.currency };
            break;
          }
          default:
            throw new Error('Okänd importtyp');
        }
        result.inserted++;
        if (result.preview.length < 200) result.preview.push(preview);
      } catch (e) {
        result.errors.push({ row: line, message: (e as Error).message });
        if (result.errors.length >= 200) break;
      }
    }
    if (opts.dryRun || result.errors.length) {
      db.exec('ROLLBACK');
      if (!opts.dryRun) result.inserted = 0;
    } else {
      db.exec('COMMIT');
      result.committed = true;
    }
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  result.errors.sort((a, b) => a.row - b.row);
  result.preview.sort((a, b) => (a.rad as number) - (b.rad as number));
  return result;
}
