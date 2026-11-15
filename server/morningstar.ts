/**
 * Morningstar-integration via Analytics Lab (Python-paketet morningstar_data).
 *
 *  - Nyckeln (MD_AUTH_TOKEN) kopieras från Analytics Lab → "Copy Authentication Token".
 *    Den hålls ENDAST i serverns minne (sparas inte i databasen) och har ett utgångsdatum.
 *  - Koppling instrument ↔ Morningstar SecId görs via ISIN och bekräftas av en användare.
 *  - Kurser hämtas för kopplade noterade instrument och sparas med källa "Morningstar".
 *    Manuellt inlagda kurser skrivs aldrig över.
 */
import { Router } from 'express';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, tx, audit } from './db.ts';
import { HttpError, requireRole } from './auth.ts';
import { bumpVersion, today } from './data.ts';
import { addDays } from './calc.ts';
import { suggestAssetClass, type Instrument } from '../shared/types.ts';

export const morningstar = Router();
const editor = requireRole('editor');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Nyckel (endast i minnet)
// ---------------------------------------------------------------------------

interface TokenState { token: string; expiresAt: string | null; setBy: string | null; setAt: string }
let tokenState: TokenState | null = null;

export function decodeJwtExpiry(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(400, 'Nyckeln ser inte ut som en nyckel från Analytics Lab (förväntat format: tre delar åtskilda med punkt)');
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    throw new HttpError(400, 'Nyckeln kunde inte läsas');
  }
}

if (process.env.MD_AUTH_TOKEN) {
  try {
    tokenState = { token: process.env.MD_AUTH_TOKEN, expiresAt: decodeJwtExpiry(process.env.MD_AUTH_TOKEN), setBy: 'miljövariabel', setAt: new Date().toISOString() };
  } catch { /* ogiltig nyckel i miljön ignoreras */ }
}

function requireToken(): string {
  if (!tokenState) throw new HttpError(400, 'Ingen Morningstar-nyckel är inlagd. Kopiera den från Analytics Lab och klistra in den.');
  if (tokenState.expiresAt && tokenState.expiresAt < new Date().toISOString()) throw new HttpError(400, 'Morningstar-nyckeln har gått ut. Hämta en ny från Analytics Lab.');
  return tokenState.token;
}

// ---------------------------------------------------------------------------
// Brygga till Python
// ---------------------------------------------------------------------------

function pythonPath() {
  if (process.env.MORNINGSTAR_PYTHON) return process.env.MORNINGSTAR_PYTHON;
  const venv = join(root, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

export async function bridge<T = Record<string, unknown>>(payload: Record<string, unknown>, token: string, timeoutMs = 180_000): Promise<T> {
  const script = process.env.MORNINGSTAR_BRIDGE ?? join(root, 'scripts', 'morningstar_bridge.py');
  return new Promise((resolve, reject) => {
    const p = spawn(pythonPath(), [script], { env: { ...process.env, MD_AUTH_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new HttpError(504, 'Morningstar svarade inte i tid')); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); reject(new HttpError(500, `Python kunde inte startas (${e.message}). Installera Python och paketet morningstar-data.`)); });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out);
        if (!res.ok) {
          const e = String(res.error ?? '');
          if (/base64|jwt|token|401|unauthori[sz]ed|signature|expired|credentials/i.test(e)) return reject(new HttpError(401, 'Morningstar godkände inte nyckeln. Hämta en ny i Analytics Lab (Copy Authentication Token) och klistra in den igen.'));
          if (/morningstar_data/i.test(e) && /No module|läsa in/i.test(e)) return reject(new HttpError(500, 'Python-paketet morningstar-data är inte installerat på servern (pip install morningstar-data).'));
          return reject(new HttpError(502, `Morningstar: ${e}`));
        }
        resolve(res as T);
      } catch {
        reject(new HttpError(502, `Oväntat svar från Morningstar-bryggan${err ? `: ${err.trim().split('\n').slice(-1)[0]}` : ''}`));
      }
    });
    p.stdin.end(JSON.stringify(payload));
  });
}

// ---------------------------------------------------------------------------
// Val av rätt listning
// ---------------------------------------------------------------------------

export interface Candidate { sec_id: string; name: string | null; ticker: string | null; isin: string | null; currency: string | null; exchange: string | null; country: string | null; security_type: string | null }

const CURRENCY_CODES: Record<string, string> = {
  'swedish krona': 'SEK', 'euro': 'EUR', 'us dollar': 'USD', 'norwegian krone': 'NOK', 'danish krone': 'DKK', 'swiss franc': 'CHF', 'pound sterling': 'GBP', 'yen': 'JPY',
};
export const currencyCode = (c: string | null) => (!c ? null : /^[A-Z]{3}$/.test(c) ? c : CURRENCY_CODES[c.toLowerCase()] ?? c);
const HOME_EXCHANGE: Record<string, RegExp> = {
  SE: /stockholm/i, DK: /copenhagen|københavn/i, NO: /oslo/i, FI: /helsinki/i, US: /nasdaq|new york|nyse/i, CH: /swiss|six/i, NL: /amsterdam/i, DE: /xetra|frankfurt/i, GB: /london/i,
};

/** Rangordnar kandidater: rätt valuta, rätt typ (aktie/fond) och hemmabörs först. */
export function rankCandidates(ins: Pick<Instrument, 'type' | 'currency' | 'isin'>, cands: Candidate[]) {
  const home = ins.isin ? HOME_EXCHANGE[ins.isin.slice(0, 2)] : undefined;
  const score = (c: Candidate) =>
    (currencyCode(c.currency) === ins.currency ? 4 : 0) +
    (ins.type === 'EQUITY' ? (c.security_type === 'ST' ? 2 : 0) : c.security_type && c.security_type !== 'ST' ? 2 : 0) +
    (home && c.exchange && home.test(c.exchange) ? 1 : 0) +
    (c.isin && ins.isin && c.isin === ins.isin ? 1 : 0);
  const ranked = cands.map((c) => ({ ...c, score: score(c) })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const clear = !!best && currencyCode(best.currency) === ins.currency && (ranked.length === 1 || ranked[1].score < best.score);
  return { ranked, suggested: best ?? null, clear };
}

/** Förväntad handelsvaluta utifrån ISIN-landet (för aktier). */
const HOME_CURRENCY: Record<string, string> = { SE: 'SEK', DK: 'DKK', NO: 'NOK', FI: 'EUR', US: 'USD', CH: 'CHF', NL: 'EUR', DE: 'EUR', FR: 'EUR', GB: 'GBP', JP: 'JPY' };
export const expectedCurrency = (isin: string, cands: Candidate[]) =>
  HOME_CURRENCY[isin.slice(0, 2)] ?? currencyCode(cands.find((c) => HOME_EXCHANGE[isin.slice(0, 2)]?.test(c.exchange ?? ''))?.currency ?? cands[0]?.currency ?? null) ?? 'SEK';

const listingLabel = (c: Candidate) => [c.ticker, c.exchange, currencyCode(c.currency)].filter(Boolean).join(' · ');

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

morningstar.get('/morningstar/status', (_req, res) => {
  const listed = all<Instrument & { ms_secid: string | null; ms_listing: string | null; last_date: string | null; last_source: string | null }>(
    `SELECT i.*, (SELECT MAX(date) FROM prices p WHERE p.instrument_id=i.id) last_date,
       (SELECT source FROM prices p WHERE p.instrument_id=i.id ORDER BY date DESC LIMIT 1) last_source
     FROM instruments i WHERE i.type != 'PE_FUND' ORDER BY i.name`,
  );
  res.json({
    token: tokenState ? { set: true, expiresAt: tokenState.expiresAt, expired: !!tokenState.expiresAt && tokenState.expiresAt < new Date().toISOString(), setBy: tokenState.setBy, setAt: tokenState.setAt } : { set: false },
    instruments: listed.map((i) => ({ id: i.id, name: i.name, isin: i.isin, type: i.type, currency: i.currency, ms_secid: i.ms_secid, ms_listing: i.ms_listing, last_date: i.last_date, last_source: i.last_source })),
    log: all('SELECT l.*, u.name user_name FROM ms_sync_log l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 10'),
  });
});

morningstar.post('/morningstar/token', editor, (req, res) => {
  const token = String(req.body?.token ?? '').trim().replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(400, 'Klistra in nyckeln');
  const expiresAt = decodeJwtExpiry(token);
  if (expiresAt && expiresAt < new Date().toISOString()) throw new HttpError(400, 'Nyckeln har redan gått ut – hämta en ny från Analytics Lab');
  tokenState = { token, expiresAt, setBy: req.user?.name ?? null, setAt: new Date().toISOString() };
  audit(req.user?.id ?? null, 'set_token', 'morningstar', null, { expiresAt }); // själva nyckeln loggas aldrig
  res.json({ ok: true, expiresAt });
});

morningstar.delete('/morningstar/token', editor, (req, res) => {
  tokenState = null;
  audit(req.user?.id ?? null, 'clear_token', 'morningstar', null);
  res.json({ ok: true });
});

morningstar.post('/morningstar/test', editor, async (_req, res) => {
  const r = await bridge<{ version: string }>({ cmd: 'ping' }, requireToken(), 60_000);
  res.json({ ok: true, version: r.version });
});

/** Föreslår Morningstar-listning för instrument som saknar koppling. Inget sparas. */
morningstar.post('/morningstar/lookup', editor, async (req, res) => {
  const ids: number[] | null = Array.isArray(req.body?.instrument_ids) ? req.body.instrument_ids.map(Number) : null;
  const targets = all<Instrument & { ms_secid: string | null }>("SELECT * FROM instruments WHERE type != 'PE_FUND' AND isin IS NOT NULL")
    .filter((i) => (ids ? ids.includes(i.id) : !i.ms_secid));
  if (!targets.length) return res.json({ results: [] });
  const r = await bridge<{ result: Record<string, Candidate[] | { error: string }> }>({ cmd: 'lookup', isins: targets.map((i) => i.isin) }, requireToken());
  res.json({
    results: targets.map((i) => {
      const found = r.result[i.isin!];
      if (!found || !Array.isArray(found)) return { instrument_id: i.id, name: i.name, isin: i.isin, error: (found as { error?: string })?.error ?? 'Ingen träff', candidates: [], suggested: null, clear: false };
      const { ranked, suggested, clear } = rankCandidates(i, found);
      return { instrument_id: i.id, name: i.name, isin: i.isin, currency: i.currency, candidates: ranked.map((c) => ({ ...c, label: listingLabel(c) })), suggested: suggested ? { ...suggested, label: listingLabel(suggested) } : null, clear };
    }),
  });
});

/** Bekräftar koppling instrument → Morningstar SecId. */
morningstar.put('/instruments/:id/morningstar', editor, (req, res) => {
  const id = Number(req.params.id);
  const ins = get<Instrument>('SELECT * FROM instruments WHERE id=?', id);
  if (!ins) throw new HttpError(404, 'Instrumentet finns inte');
  const secId = req.body?.sec_id ? String(req.body.sec_id).trim() : null;
  if (secId && !/^[A-Z0-9]{6,12}(;[A-Z]{2})?$/i.test(secId)) throw new HttpError(400, 'Ogiltigt Morningstar-id');
  run('UPDATE instruments SET ms_secid=?, ms_listing=? WHERE id=?', secId, secId ? String(req.body?.listing ?? '').slice(0, 120) || null : null, id);
  audit(req.user?.id ?? null, secId ? 'map' : 'unmap', 'morningstar', id, { instrument: ins.name, sec_id: secId, listing: req.body?.listing });
  res.json({ ok: true });
});

/** Hämtar kurser från Morningstar för kopplade instrument och sparar dem. */
morningstar.post('/morningstar/sync', editor, async (req, res) => {
  const token = requireToken();
  const to = typeof req.body?.to === 'string' ? req.body.to : today();
  const defaultFrom = typeof req.body?.from === 'string' ? req.body.from : addDays(to, -30);
  const mapped = all<Instrument & { ms_secid: string; last_date: string | null }>(
    `SELECT i.*, (SELECT MAX(date) FROM prices p WHERE p.instrument_id=i.id AND p.source='Morningstar') last_date
     FROM instruments i WHERE i.ms_secid IS NOT NULL AND i.type != 'PE_FUND'`,
  );
  if (!mapped.length) throw new HttpError(400, 'Inga instrument är kopplade till Morningstar ännu');
  const from = req.body?.from ? defaultFrom : mapped.reduce((m, i) => { const f = i.last_date ? addDays(i.last_date, 1) : defaultFrom; return f < m ? f : m; }, to);
  const r = await bridge<{ rows: { sec_id: string; date: string; price: number; datapoint: string }[] }>({ cmd: 'prices', sec_ids: mapped.map((i) => i.ms_secid.split(';')[0]), start: from < defaultFrom ? defaultFrom : from, end: to }, token);
  const bySec = new Map(mapped.map((i) => [i.ms_secid.split(';')[0], i]));
  const summary = new Map<number, { name: string; inserted: number; updated: number; skippedManual: number; last: { date: string; price: number } | null; jump: number | null }>();
  tx(() => {
    for (const row of r.rows) {
      const ins = bySec.get(row.sec_id);
      if (!ins || !(row.price > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
      const s = summary.get(ins.id) ?? { name: ins.name, inserted: 0, updated: 0, skippedManual: 0, last: null, jump: null };
      const existing = get<{ price: number; source: string | null }>('SELECT price, source FROM prices WHERE instrument_id=? AND date=?', ins.id, row.date);
      if (existing?.source === 'Manuell') { s.skippedManual++; summary.set(ins.id, s); continue; }
      run('INSERT INTO prices (instrument_id,date,price,source) VALUES (?,?,?,?) ON CONFLICT(instrument_id,date) DO UPDATE SET price=excluded.price, source=excluded.source', ins.id, row.date, row.price, 'Morningstar');
      if (existing) s.updated++; else s.inserted++;
      if (!s.last || row.date > s.last.date) s.last = { date: row.date, price: row.price };
      summary.set(ins.id, s);
    }
    // Rimlighetskontroll: stor skillnad mot föregående kurs från annan källa
    for (const [id, s] of summary) {
      if (!s.last) continue;
      const prev = get<{ price: number }>("SELECT price FROM prices WHERE instrument_id=? AND date < ? AND (source IS NULL OR source != 'Morningstar') ORDER BY date DESC LIMIT 1", id, s.last.date);
      if (prev) s.jump = s.last.price / prev.price - 1;
    }
  });
  const missing = mapped.filter((i) => !summary.has(i.id)).map((i) => i.name);
  const rows = [...summary.values()];
  const total = rows.reduce((a, s) => a + s.inserted + s.updated, 0);
  run('INSERT INTO ms_sync_log (user_id, kind, ok, summary, details) VALUES (?,?,?,?,?)', req.user?.id ?? null, 'prices', 1,
    `${total} kurser för ${rows.length} instrument (${from}–${to})${missing.length ? `, ${missing.length} utan data` : ''}`, JSON.stringify({ rows, missing }));
  audit(req.user?.id ?? null, 'sync_prices', 'morningstar', null, { from, to, total, missing });
  bumpVersion();
  res.json({ from, to, total, instruments: rows, missing });
});

/** Grunddata för ett nytt instrument utifrån ISIN – för att förifylla formuläret. */
morningstar.post('/morningstar/describe', editor, async (req, res) => {
  const isin = String(req.body?.isin ?? '').trim().toUpperCase();
  const currency = String(req.body?.currency ?? '').toUpperCase() || null;
  const type = (req.body?.type ?? 'EQUITY') as Instrument['type'];
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) throw new HttpError(400, 'Ange ett giltigt ISIN först');
  const token = requireToken();
  const lk = await bridge<{ result: Record<string, Candidate[] | { error: string }> }>({ cmd: 'lookup', isins: [isin] }, token);
  const cands = lk.result[isin];
  if (!Array.isArray(cands) || !cands.length) throw new HttpError(404, 'Morningstar hittade inget instrument med detta ISIN');
  const guessType: Instrument['type'] = cands.some((c) => c.security_type === 'ST') ? 'EQUITY' : 'FUND';
  const { suggested, ranked } = rankCandidates({ type: req.body?.type ? type : guessType, currency: currency ?? (guessType === 'EQUITY' ? expectedCurrency(isin, cands) : currencyCode(cands[0].currency) ?? 'SEK'), isin }, cands);
  const d = await bridge<{ rows: Record<string, unknown>[] }>({ cmd: 'describe', sec_ids: [suggested!.sec_id] }, token);
  const row = d.rows[0] ?? {};
  const pick = (re: RegExp) => { const k = Object.keys(row).find((x) => re.test(x)); return k ? (row[k] as string | null) : null; };
  const t = req.body?.type ? type : guessType;
  const sector = pick(/sector/i);
  const category = pick(/category/i);
  const fields = {
    type: t,
    name: pick(/^name$/i) ?? suggested!.name,
    isin,
    ticker: suggested!.ticker,
    currency: currencyCode(pick(/currency/i) ?? suggested!.currency),
    sector: t === 'EQUITY' ? sector : category,
    fund_category: t === 'FUND' ? (/bond|fixed|ränt|obligation/i.test(category ?? '') ? 'Räntefond' : /alternative|hedge/i.test(category ?? '') ? 'Hedgefond' : 'Aktiefond') : null,
    region: /emerging/i.test(category ?? '') ? 'Tillväxtmarknader' : /global/i.test(category ?? '') ? 'Global' : null,
  };
  res.json({ fields: { ...fields, ...suggestAssetClass({ type: t, fund_category: fields.fund_category, strategy: null, region: fields.region, country: isin.slice(0, 2), sector: fields.sector }) }, ms: { sec_id: suggested!.sec_id, listing: listingLabel(suggested!) }, candidates: ranked.map((c) => ({ ...c, label: listingLabel(c) })) });
});
