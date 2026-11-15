import { all } from './db.ts';
import { Market, type PortfolioData } from './calc.ts';
import type { Entity, Instrument, Transaction } from '../shared/types.ts';

/** Ökas vid varje skrivning så att cachade beräkningar invalideras. */
let version = 0;
export const bumpVersion = () => {
  version++;
  cache.clear();
  market = null;
};

let market: Market | null = null;
export function getMarket(): Market {
  if (!market) {
    market = new Market({
      prices: all('SELECT instrument_id, date, price FROM prices'),
      fx: all('SELECT currency, date, rate FROM fx_rates'),
      valuations: all('SELECT entity_id, instrument_id, date, nav FROM pe_valuations'),
    });
  }
  return market;
}

const cache = new Map<string, unknown>();
export function cached<T>(key: string, fn: () => T): T {
  const k = `${version}|${key}`;
  if (cache.has(k)) return cache.get(k) as T;
  const v = fn();
  if (cache.size > 200) cache.clear();
  cache.set(k, v);
  return v;
}

export const instruments = () => all<Instrument>('SELECT * FROM instruments ORDER BY name');
export const entities = () => all<Entity>('SELECT id, name, org_nr FROM entities ORDER BY name');

export function transactionsFor(entityIds: number[] | null): Transaction[] {
  if (!entityIds) return all<Transaction>('SELECT * FROM transactions');
  if (entityIds.length === 0) return [];
  return all<Transaction>(`SELECT * FROM transactions WHERE entity_id IN (${entityIds.map(() => '?').join(',')})`, ...entityIds);
}

export function portfolioData(entityIds: number[] | null): PortfolioData {
  return { instruments: instruments(), transactions: transactionsFor(entityIds), market: getMarket() };
}

/** Parse "1,2,3" → [1,2,3]; tomt/saknas → null (= alla). */
export function parseEntities(q: unknown): number[] | null {
  if (typeof q !== 'string' || q.trim() === '' || q === 'all') return null;
  return q.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function parseDate(q: unknown, fallback: string): string {
  return typeof q === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : fallback;
}
