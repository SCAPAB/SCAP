// Typer som delas mellan server och klient.

export type InstrumentType = 'EQUITY' | 'FUND' | 'PE_FUND';
export type TxType = 'BUY' | 'SELL' | 'DIVIDEND' | 'FEE' | 'COMMITMENT' | 'CALL' | 'DISTRIBUTION';
export type Role = 'admin' | 'editor' | 'viewer';

export const LISTED_TX_TYPES: TxType[] = ['BUY', 'SELL', 'DIVIDEND', 'FEE'];
export const PE_TX_TYPES: TxType[] = ['COMMITMENT', 'CALL', 'DISTRIBUTION', 'FEE'];

export const TX_LABELS: Record<TxType, string> = {
  BUY: 'Köp',
  SELL: 'Sälj',
  DIVIDEND: 'Utdelning',
  FEE: 'Avgift',
  COMMITMENT: 'Åtagande',
  CALL: 'Kapitalanrop',
  DISTRIBUTION: 'Utdelning/återbetalning',
};

/** Instrumenttyp = juridisk form/vehikel. Styr beräkningsmetod (noterat vs. slutet åtagande). */
export const TYPE_LABELS: Record<InstrumentType, string> = {
  EQUITY: 'Direktägd aktie',
  FUND: 'Öppen fond',
  PE_FUND: 'Sluten fond',
};

export interface Entity {
  id: number;
  name: string;
  org_nr: string | null;
}

export interface Instrument {
  id: number;
  type: InstrumentType;
  name: string;
  isin: string | null;
  ticker: string | null;
  currency: string;
  country: string | null;
  region: string | null;
  sector: string | null;
  fund_category: string | null;
  manager: string | null;
  strategy: string | null;
  vintage: number | null;
  asset_class: AssetClass;
  sub_class: string | null;
}

export interface Transaction {
  id: number;
  entity_id: number;
  instrument_id: number;
  type: TxType;
  trade_date: string;
  settle_date: string | null;
  quantity: number;
  price: number;
  amount: number;
  fee: number;
  fx_rate: number;
  note: string | null;
  /** PE: del av kapitalanropet som ligger utanför åtagandet (t.ex. utjämningsränta) – minskar inte outnyttjat */
  outside_commitment?: number;
  /** PE: del av utdelningen som får anropas igen (recallable) – ökar outnyttjat åtagande */
  recallable?: number;
}

/** Position i ett noterat instrument (aktie eller fond). Belopp i "Base" är i SEK. */
export interface ListedHolding {
  instrumentId: number;
  entityIds: number[];
  quantity: number;
  avgCostLocal: number;
  costLocal: number;
  costBase: number;
  price: number;
  priceDate: string | null;
  fx: number;
  /** Datum för valutakursen som används vid värderingen (null för SEK) */
  fxDate: string | null;
  /** 'register' = registrerad valutakurs på eller före dagen, 'transaction' = reserv: kursen från senaste egna affären */
  fxSource: 'register' | 'transaction';
  mvLocal: number;
  mvBase: number;
  unrealizedLocal: number;
  unrealizedBase: number;
  fxEffectBase: number;
  realizedBase: number;
  dividendsBase: number;
  feesBase: number;
  totalPnlBase: number;
  unrealizedPct: number | null;
}

export interface PeHolding {
  instrumentId: number;
  entityIds: number[];
  commitment: number;
  called: number;
  uncalled: number;
  distributed: number;
  fees: number;
  paidIn: number;
  nav: number;
  navReportDate: string | null;
  navEstimated: boolean;
  fx: number;
  /** Datum för valutakursen som används vid värderingen (null för SEK) */
  fxDate: string | null;
  /** 'register' = registrerad valutakurs på eller före dagen, 'transaction' = reserv: kursen från senaste egna affären */
  fxSource: 'register' | 'transaction';
  commitmentBase: number;
  paidInBase: number;
  distributedBase: number;
  navBase: number;
  uncalledBase: number;
  pnlBase: number;
  dpi: number | null;
  rvpi: number | null;
  tvpi: number | null;
  irr: number | null;
  irrBase: number | null;
  calledPct: number | null;
}

export interface Cashflow {
  date: string;
  amount: number;
}

export interface SeriesPoint {
  date: string;
  value: number;      // marknadsvärde SEK
  netInvested: number; // ackumulerat nettoinvesterat SEK
  index: number;      // tidsviktad avkastning, start = 100
}

export interface PeriodReturn {
  key: string;
  label: string;
  from: string;
  value: number | null; // decimal, 0.05 = 5 %
}

export interface AllocationRow {
  key: string;
  value: number;
  share: number;
}

export interface Me {
  id: number;
  email: string;
  name: string;
  role: Role;
}

// ---------------------------------------------------------------------------
// Tillgångsslag (ekonomisk exponering) – skilt från instrumenttyp (juridisk form/vehikel).
// En aktiefond och en direktägd aktie är båda "Noterade aktier"; en infrastrukturfond är
// en sluten privat fond men tillhör "Reala tillgångar".
// ---------------------------------------------------------------------------

export type AssetClass = 'PUBLIC_EQUITY' | 'FIXED_INCOME' | 'PRIVATE_EQUITY' | 'REAL_ASSETS' | 'ABSOLUTE_RETURN';

export const ASSET_CLASSES: { key: AssetClass; label: string; short: string; path: string; subs: string[] }[] = [
  { key: 'PUBLIC_EQUITY', label: 'Noterade aktier', short: 'Noterade aktier', path: 'noterade-aktier', subs: ['Sverige', 'Utvecklade marknader', 'Tillväxtmarknader'] },
  { key: 'FIXED_INCOME', label: 'Räntebärande', short: 'Räntor', path: 'rantor', subs: ['Statsobligationer', 'Företagsobligationer', 'High yield'] },
  { key: 'PRIVATE_EQUITY', label: 'Private equity', short: 'Private equity', path: 'private-equity', subs: ['Buyout', 'Growth', 'Venture', 'Secondaries'] },
  { key: 'REAL_ASSETS', label: 'Reala tillgångar', short: 'Reala tillgångar', path: 'reala-tillgangar', subs: ['Infrastruktur', 'Fastigheter', 'Naturresurser'] },
  { key: 'ABSOLUTE_RETURN', label: 'Absolute return', short: 'Absolute return', path: 'absolute-return', subs: ['Multi-strategi', 'Event driven', 'Relative value'] },
];
export const ASSET_CLASS_LABEL = Object.fromEntries(ASSET_CLASSES.map((a) => [a.key, a.label])) as Record<AssetClass, string>;

/** Förslag på tillgångsslag och delsegment utifrån instrumentets egenskaper. */
export function suggestAssetClass(i: Pick<Instrument, 'type' | 'fund_category' | 'strategy' | 'region' | 'country' | 'sector'>): { asset_class: AssetClass; sub_class: string } {
  const region = (r: string | null, c: string | null) =>
    r === 'Tillväxtmarknader' ? 'Tillväxtmarknader' : c === 'SE' && r !== 'Global' ? 'Sverige' : 'Utvecklade marknader';
  if (i.type === 'PE_FUND') {
    const s = (i.strategy ?? '').toLowerCase();
    if (/infra/.test(s)) return { asset_class: 'REAL_ASSETS', sub_class: 'Infrastruktur' };
    if (/fastighet|real estate/.test(s)) return { asset_class: 'REAL_ASSETS', sub_class: 'Fastigheter' };
    if (/natur|skog|energi|resour/.test(s)) return { asset_class: 'REAL_ASSETS', sub_class: 'Naturresurser' };
    if (/credit|debt|kredit/.test(s)) return { asset_class: 'FIXED_INCOME', sub_class: 'Företagsobligationer' };
    const sub = ['Buyout', 'Growth', 'Venture', 'Secondaries'].find((x) => s.includes(x.toLowerCase())) ?? 'Buyout';
    return { asset_class: 'PRIVATE_EQUITY', sub_class: sub };
  }
  if (i.type === 'FUND') {
    const c = (i.fund_category ?? '').toLowerCase();
    if (/ränt|obligation|kredit/.test(c)) return { asset_class: 'FIXED_INCOME', sub_class: /high/.test((i.sector ?? '').toLowerCase()) ? 'High yield' : /stat/.test((i.sector ?? '').toLowerCase()) ? 'Statsobligationer' : 'Företagsobligationer' };
    if (/hedge|alternativ|absolute/.test(c)) return { asset_class: 'ABSOLUTE_RETURN', sub_class: 'Multi-strategi' };
  }
  return { asset_class: 'PUBLIC_EQUITY', sub_class: region(i.region, i.country) };
}
