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

export const TYPE_LABELS: Record<InstrumentType, string> = {
  EQUITY: 'Aktie',
  FUND: 'Fond',
  PE_FUND: 'PE-fond',
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
