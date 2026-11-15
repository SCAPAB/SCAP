/**
 * Fyller databasen med DEMODATA. Kurser, NAV och kassaflöden är syntetiska (slumpvandring med fast frö)
 * och ska inte tolkas som verkliga marknadsdata. Kör: npm run seed  (raderar befintligt innehåll!)
 */
import bcrypt from 'bcryptjs';
import { db, run, get, all, tx } from './db.ts';
import { suggestAssetClass, type Instrument } from '../shared/types.ts';
import { addDays } from './calc.ts';

const TODAY = process.env.SEED_TODAY ?? new Date().toISOString().slice(0, 10);
const START = '2023-01-02';

// Deterministisk slump (mulberry32)
let seed = 20240607;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

const weekdays: string[] = [];
for (let d = START; d <= TODAY; d = addDays(d, 1)) {
  const wd = new Date(d + 'T00:00:00Z').getUTCDay();
  if (wd !== 0 && wd !== 6) weekdays.push(d);
}
const nearestTradingDay = (d: string) => weekdays.find((w) => w >= d) ?? weekdays[weekdays.length - 1];

function walk(start: number, annualDrift: number, annualVol: number) {
  const dt = 1 / 252;
  const out = new Map<string, number>();
  let p = start;
  for (const d of weekdays) {
    out.set(d, p);
    p *= Math.exp((annualDrift - 0.5 * annualVol ** 2) * dt + annualVol * Math.sqrt(dt) * gauss());
  }
  return out;
}

tx(() => {
  for (const t of ['ms_sync_log', 'aliases', 'policy_targets', 'settings', 'proposals', 'extraction_rules', 'audit_log', 'sessions', 'transactions', 'documents', 'prices', 'pe_valuations', 'fx_rates', 'instruments', 'entities', 'users']) run(`DELETE FROM ${t}`);

  // Användare
  const pw = process.env.ADMIN_PASSWORD ?? 'innehav';
  run('INSERT INTO users (email,name,password_hash,role) VALUES (?,?,?,?)', 'admin@innehav.local', 'Administratör', bcrypt.hashSync(pw, 10), 'admin');
  run('INSERT INTO users (email,name,password_hash,role) VALUES (?,?,?,?)', 'granskare@innehav.local', 'Granskare (attest)', bcrypt.hashSync(pw, 10), 'editor');
  run('INSERT INTO users (email,name,password_hash,role) VALUES (?,?,?,?)', 'lasare@innehav.local', 'Läsbehörighet', bcrypt.hashSync(pw, 10), 'viewer');

  // Policyportfölj (strategisk allokering) – andel av totalt marknadsvärde
  for (const [k, t, lo, hi] of [
    ['PUBLIC_EQUITY', 0.525, 0.45, 0.65], ['FIXED_INCOME', 0.05, 0.02, 0.10], ['PRIVATE_EQUITY', 0.30, 0.20, 0.40],
    ['REAL_ASSETS', 0.05, 0.03, 0.10], ['ABSOLUTE_RETURN', 0.075, 0.05, 0.10],
  ] as const) run('INSERT INTO policy_targets (asset_class, target, min, max) VALUES (?,?,?,?)', k, t, lo, hi);
  run("INSERT INTO settings (key, value) VALUES ('dual_control', 'off')");

  // Programmet hanterar EN juridisk enhet (namn och org.nr ändras under Administration → Organisation)
  run('INSERT INTO entities (id, name, org_nr) VALUES (1, ?, ?)', process.env.SEED_ENTITY ?? 'Lantbrukarnas Ekonomi AB', process.env.SEED_ORGNR ?? null);

  // Valutakurser (SEK per enhet)
  const fxDefs: Record<string, [number, number]> = { USD: [10.4, 0.09], EUR: [11.15, 0.06], NOK: [1.06, 0.08], DKK: [1.5, 0.06], CHF: [11.3, 0.07] };
  const fx: Record<string, Map<string, number>> = {};
  for (const [c, [s, v]] of Object.entries(fxDefs)) {
    fx[c] = walk(s, 0, v);
    for (const [d, r] of fx[c]) run('INSERT INTO fx_rates (currency,date,rate) VALUES (?,?,?)', c, d, round(r, 4));
  }
  const fxAt = (c: string, d: string) => (c === 'SEK' ? 1 : fx[c].get(nearestTradingDay(d))!);

  // Instrument
  type Def = { type: 'EQUITY' | 'FUND'; name: string; isin: string | null; ticker?: string; ccy: string; country: string; region: string; sector: string; cat?: string; mgr?: string; px: number; mu: number; vol: number; dy: number };
  const listed: Def[] = [
    { type: 'EQUITY', name: 'Volvo B', isin: 'SE0000115446', ticker: 'VOLV B', ccy: 'SEK', country: 'SE', region: 'Norden', sector: 'Industri', px: 190, mu: 0.12, vol: 0.27, dy: 0.04 },
    { type: 'EQUITY', name: 'Atlas Copco A', isin: 'SE0017486889', ticker: 'ATCO A', ccy: 'SEK', country: 'SE', region: 'Norden', sector: 'Industri', px: 125, mu: 0.14, vol: 0.26, dy: 0.02 },
    { type: 'EQUITY', name: 'Investor B', isin: 'SE0015811963', ticker: 'INVE B', ccy: 'SEK', country: 'SE', region: 'Norden', sector: 'Finans', px: 190, mu: 0.15, vol: 0.2, dy: 0.02 },
    { type: 'EQUITY', name: 'Ericsson B', isin: 'SE0000108656', ticker: 'ERIC B', ccy: 'SEK', country: 'SE', region: 'Norden', sector: 'Informationsteknik', px: 61, mu: 0.0, vol: 0.32, dy: 0.04 },
    { type: 'EQUITY', name: 'Essity B', isin: 'SE0009922164', ticker: 'ESSITY B', ccy: 'SEK', country: 'SE', region: 'Norden', sector: 'Dagligvaror', px: 275, mu: 0.05, vol: 0.2, dy: 0.028 },
    { type: 'EQUITY', name: 'Novo Nordisk B', isin: 'DK0062498333', ticker: 'NOVO B', ccy: 'DKK', country: 'DK', region: 'Norden', sector: 'Hälsovård', px: 470, mu: 0.08, vol: 0.33, dy: 0.015 },
    { type: 'EQUITY', name: 'Equinor', isin: 'NO0010096985', ticker: 'EQNR', ccy: 'NOK', country: 'NO', region: 'Norden', sector: 'Energi', px: 350, mu: 0.02, vol: 0.28, dy: 0.05 },
    { type: 'EQUITY', name: 'Nestlé', isin: 'CH0038863350', ticker: 'NESN', ccy: 'CHF', country: 'CH', region: 'Europa', sector: 'Dagligvaror', px: 108, mu: 0.0, vol: 0.17, dy: 0.03 },
    { type: 'EQUITY', name: 'ASML Holding', isin: 'NL0010273215', ticker: 'ASML', ccy: 'EUR', country: 'NL', region: 'Europa', sector: 'Informationsteknik', px: 520, mu: 0.15, vol: 0.35, dy: 0.01 },
    { type: 'EQUITY', name: 'Apple', isin: 'US0378331005', ticker: 'AAPL', ccy: 'USD', country: 'US', region: 'Nordamerika', sector: 'Informationsteknik', px: 128, mu: 0.2, vol: 0.27, dy: 0.005 },
    { type: 'EQUITY', name: 'Microsoft', isin: 'US5949181045', ticker: 'MSFT', ccy: 'USD', country: 'US', region: 'Nordamerika', sector: 'Informationsteknik', px: 240, mu: 0.22, vol: 0.25, dy: 0.008 },
    { type: 'FUND', name: 'Demo Sverige Aktiefond', isin: null, ccy: 'SEK', country: 'SE', region: 'Norden', sector: 'Sverige', cat: 'Aktiefond', mgr: 'Demo Fonder AB', px: 310, mu: 0.1, vol: 0.18, dy: 0 },
    { type: 'FUND', name: 'Demo Global Indexfond', isin: null, ccy: 'SEK', country: 'SE', region: 'Global', sector: 'Global', cat: 'Aktiefond', mgr: 'Demo Fonder AB', px: 185, mu: 0.13, vol: 0.14, dy: 0 },
    { type: 'FUND', name: 'Demo Europa Småbolag', isin: null, ccy: 'EUR', country: 'LU', region: 'Europa', sector: 'Småbolag Europa', cat: 'Aktiefond', mgr: 'Exempel Asset Management S.A.', px: 42, mu: 0.07, vol: 0.2, dy: 0 },
    { type: 'FUND', name: 'Demo Tillväxtmarknader', isin: null, ccy: 'USD', country: 'IE', region: 'Tillväxtmarknader', sector: 'Tillväxtmarknader', cat: 'Aktiefond', mgr: 'Exempel Global Investors plc', px: 23, mu: 0.06, vol: 0.19, dy: 0 },
    { type: 'FUND', name: 'Demo Multi-Strategy Fund', isin: null, ccy: 'USD', country: 'KY', region: 'Global', sector: 'Multi-strategi', cat: 'Hedgefond', mgr: 'Exempel Capital Management LP', px: 1180, mu: 0.03, vol: 0.04, dy: 0 },
    { type: 'FUND', name: 'Demo Företagsobligationer', isin: null, ccy: 'SEK', country: 'SE', region: 'Norden', sector: 'Företagsobligationer', cat: 'Räntefond', mgr: 'Demo Fonder AB', px: 104, mu: 0.035, vol: 0.02, dy: 0 },
  ];
  const ids: number[] = [];
  for (const d of listed) {
    const r = run(
      'INSERT INTO instruments (type,name,isin,ticker,currency,country,region,sector,fund_category,manager) VALUES (?,?,?,?,?,?,?,?,?,?)',
      d.type, d.name, d.isin, d.ticker ?? null, d.ccy, d.country, d.region, d.sector, d.cat ?? null, d.mgr ?? null,
    );
    ids.push(Number(r.lastInsertRowid));
  }

  // Kurser + transaktioner för noterade
  const ins = db.prepare('INSERT INTO transactions (entity_id,instrument_id,type,trade_date,quantity,price,amount,fee,fx_rate,note) VALUES (?,?,?,?,?,?,?,?,?,?)');
  listed.forEach((d, i) => {
    const id = ids[i];
    const px = walk(d.px, d.mu, d.vol);
    for (const [date, p] of px) run('INSERT INTO prices (instrument_id,date,price,source) VALUES (?,?,?,?)', id, date, round(p, d.px < 50 ? 4 : 2), 'Demo');
    const pxAt = (date: string) => px.get(nearestTradingDay(date))!;
    const owners = [1];
    const holdings = new Map<number, number>();
    const trade = (ent: number, type: 'BUY' | 'SELL', date: string, budgetSek: number | null, qtyIn?: number) => {
      const td = nearestTradingDay(date);
      const p = round(pxAt(td), 4);
      const f = fxAt(d.ccy, td);
      const qty = qtyIn ?? Math.max(1, Math.round(budgetSek! / (p * f) / (d.type === 'FUND' ? 1 : 10)) * (d.type === 'FUND' ? 1 : 10));
      const amount = round(qty * p);
      const fee = d.type === 'FUND' ? 0 : round(Math.max(39, amount * 0.0004));
      ins.run(ent, id, type, td, qty, p, amount, fee, round(f, 4), null);
      holdings.set(ent, (holdings.get(ent) ?? 0) + (type === 'BUY' ? qty : -qty));
    };
    for (const ent of owners) {
      const size = 45e6 * (0.6 + rand() * 0.8);
      trade(ent, 'BUY', addDays(START, Math.floor(rand() * 40)), size);
      trade(ent, 'BUY', addDays('2024-03-01', Math.floor(rand() * 120)), size * 0.3);
      if (rand() < 0.6) {
        const q = Math.round((holdings.get(ent) ?? 0) * 0.25);
        if (q > 0) trade(ent, 'SELL', addDays('2025-02-01', Math.floor(rand() * 200)), null, q);
      }
      if (rand() < 0.5) trade(ent, 'BUY', addDays('2025-09-01', Math.floor(rand() * 60)), size * 0.2);
    }
    // Utdelningar (aktier) i maj varje år
    if (d.dy > 0) {
      for (const y of [2023, 2024, 2025, 2026]) {
        const date = nearestTradingDay(`${y}-05-0${3 + (i % 5)}`);
        if (date > TODAY) continue;
        for (const ent of owners) {
          // Antal per utdelningsdatum
          const q = (db.prepare("SELECT COALESCE(SUM(CASE type WHEN 'BUY' THEN quantity WHEN 'SELL' THEN -quantity END),0) q FROM transactions WHERE entity_id=? AND instrument_id=? AND trade_date<=?").get(ent, id, date) as { q: number }).q;
          if (q <= 0) continue;
          const dps = round(pxAt(date) * d.dy, 2);
          const gross = round(q * dps);
          const wht = d.ccy === 'SEK' ? 0 : round(gross * 0.15);
          ins.run(ent, id, 'DIVIDEND', date, 0, dps, gross, wht, round(fxAt(d.ccy, date), 4), wht ? 'Källskatt 15 %' : null);
        }
      }
    }
  });

  // PE-fonder
  const peDefs = [
    { name: 'Nordic Buyout Partners IV', ccy: 'EUR', country: 'SE', region: 'Norden', strategy: 'Buyout', vintage: 2019, mgr: 'Exempel Partners', commit: [[1, 25e6]], moic: 1.9, start: '2019-09-30' },
    { name: 'Global Infrastructure Fund V', ccy: 'USD', country: 'US', region: 'Global', strategy: 'Infrastruktur', vintage: 2020, mgr: 'Exempel Infrastructure LP', commit: [[1, 12e6]], moic: 1.45, start: '2020-06-30' },
    { name: 'Scandinavian Growth Fund II', ccy: 'SEK', country: 'SE', region: 'Norden', strategy: 'Growth', vintage: 2021, mgr: 'Exempel Growth AB', commit: [[1, 200e6]], moic: 1.35, start: '2021-12-31' },
    { name: 'Northern Ventures III', ccy: 'SEK', country: 'SE', region: 'Norden', strategy: 'Venture', vintage: 2022, mgr: 'Exempel Ventures AB', commit: [[1, 60e6]], moic: 0.92, start: '2022-09-30' },
    { name: 'European Mid-Market Fund VI', ccy: 'EUR', country: 'LU', region: 'Europa', strategy: 'Buyout', vintage: 2024, mgr: 'Exempel Capital S.à r.l.', commit: [[1, 28e6]], moic: 1.08, start: '2024-03-31' },
  ];
  // FX före 2023: använd första kända kurs
  const fxPe = (c: string, d: string) => (c === 'SEK' ? 1 : d < weekdays[0] ? fx[c].get(weekdays[0])! : fxAt(c, d));
  const quarterEnds: string[] = [];
  for (let y = 2019; y <= 2026; y++) for (const q of ['03-31', '06-30', '09-30', '12-31']) quarterEnds.push(`${y}-${q}`);
  for (const p of peDefs) {
    const r = run(
      'INSERT INTO instruments (type,name,currency,country,region,sector,manager,strategy,vintage,fund_category) VALUES (?,?,?,?,?,?,?,?,?,?)',
      'PE_FUND', p.name, p.ccy, p.country, p.region, p.strategy, p.mgr, p.strategy, p.vintage, 'Private equity',
    );
    const id = Number(r.lastInsertRowid);
    for (const [ent, commit] of p.commit) {
      ins.run(ent, id, 'COMMITMENT', p.start, 0, 0, commit, 0, round(fxPe(p.ccy, p.start), 4), 'Signerat åtagande');
      let called = 0;
      let distributed = 0;
      let nav = 0;
      const qs = quarterEnds.filter((q) => q > p.start);
      qs.forEach((q, k) => {
        const age = (k + 1) / 4; // år sedan start
        const callDate = addDays(q, -20);
        if (callDate > TODAY) return;
        // Anrop: avtagande takt de första ~5 åren
        if (called < commit * 0.92 && age <= 5.5) {
          const c = round(Math.min(commit * 0.92 - called, commit * (age < 1 ? 0.07 : age < 3 ? 0.06 : 0.035) * (0.6 + rand() * 0.8)), 0);
          if (c > 0) {
            ins.run(ent, id, 'CALL', callDate, 0, 0, c, 0, round(fxPe(p.ccy, callDate), 4), age < 1 ? 'Inkl. förvaltningsavgift' : null);
            called += c;
            nav += c;
          }
        }
        // Värdeutveckling: J-kurva mot mål-MOIC
        const target = Math.pow(p.moic, 1 / 6);
        const growth = age < 1.5 ? 0.985 : Math.pow(target, 0.25) * (1 + gauss() * 0.03);
        nav *= growth;
        // Utdelningar efter år 4
        if (age > 4 && nav > 0 && rand() < 0.45) {
          const dAmt = round(nav * (0.08 + rand() * 0.12), 0);
          const dd = addDays(q, -5);
          if (dd <= TODAY) {
            ins.run(ent, id, 'DISTRIBUTION', dd, 0, 0, dAmt, 0, round(fxPe(p.ccy, dd), 4), 'Exit portföljbolag');
            distributed += dAmt;
            nav -= dAmt;
          }
        }
        // NAV-rapport publiceras ~60 dagar efter kvartalsslut
        if (addDays(q, 60) <= TODAY) run('INSERT INTO pe_valuations (entity_id,instrument_id,date,nav,source) VALUES (?,?,?,?,?)', ent, id, q, round(nav, 0), 'Kvartalsrapport GP');
      });
    }
  }
  // Tillgångsslag utifrån instrumentens egenskaper
  for (const i of all<Instrument>('SELECT * FROM instruments')) {
    const a = suggestAssetClass(i);
    run('UPDATE instruments SET asset_class=?, sub_class=? WHERE id=?', a.asset_class, a.sub_class, i.id);
  }
  const n = get<{ n: number }>('SELECT COUNT(*) n FROM transactions')!.n;
  console.log(`Demodata skapad per ${TODAY}: ${ids.length + peDefs.length} instrument, ${n} transaktioner.`);
  console.log(`Inloggning: admin@innehav.local / ${pw === 'innehav' ? 'innehav' : '(ADMIN_PASSWORD)'}`);
});
