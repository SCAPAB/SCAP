/**
 * Matchning av namn i dokument mot våra instrument och juridiska enheter.
 *
 * Erfarenheter från verkligheten som styr reglerna:
 *  - GP:er använder juridiska fondnamn ("Nordic Buyout Partners IV SCSp") medan vi har interna namn.
 *    Därför lär sig systemet alias när en människa har godkänt en matchning.
 *  - Fondnummer är avgörande: "Fund IV" och "Fund V" är olika åtaganden.
 *  - Vehikel spelar roll: huvudfond, parallellfond, feeder och co-invest är olika åtaganden.
 *  - Andelsklass och valuta spelar roll för öppna fonder: "A SEK" och "B EUR" har olika kurser.
 *  - Juridiska suffix (AB, LP, SCSp, S.à r.l. …) saknar betydelse.
 *  - Endast ISIN, inlärt alias, org.nr eller i praktiken identiskt namn räknas som säker träff.
 *    Allt annat är ett förslag som granskaren måste bekräfta.
 */
import { all, get, run } from './db.ts';
import type { Entity, Instrument } from '../shared/types.ts';

const LEGAL = /\b(l\.p\.|lp|scsp|scs|sca|s\.c\.a\.|s\.?à\.?\s?r\.?\s?l\.?|sarl|s\.a\.|ltd\.?|limited partnership|limited|inc\.|plc|llc|gmbh|kg|gp|ab|\(publ\)|publ|asa|a\/s|oyj|n\.v\.|sicav|raif|fcp|icav|ucits)\b/g;
const NOISE = new Set(['fund', 'fond', 'the', 'of', 'and', 'co', 'aktiefond', 'feederfund', 'l', 'p']);
const QUALIFIERS = new Set(['feeder', 'parallel', 'coinvest', 'coinvestment', 'annex', 'sidecar', 'continuation', 'topup', 'opportunities', 'opportunity', 'overflow', 'blocker', 'aiv']);
const CLASS = new Set(['a', 'b', 'c', 'd', 'e', 'i', 'r', 'acc', 'dist', 'dis', 'sek', 'eur', 'usd', 'nok', 'dkk', 'gbp', 'chf', 'hedged', 'h']);
const ROMAN = /^(x{0,3})(ix|iv|v?i{0,3})$/;

export function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/co-?invest(ment)?/g, 'coinvest').replace(/top-up/g, 'topup')
    .replace(LEGAL, ' ').replace(/\bno\.?\s*(\d+)\b/g, ' nr$1 ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function tokens(s: string) {
  return normalize(s).split(' ').filter((t) => t && !NOISE.has(t));
}
function dice(a: string, b: string) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bg = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1); return m; };
  const A = bg(a); const B = bg(b); let o = 0;
  for (const [k, n] of A) o += Math.min(n, B.get(k) ?? 0);
  return (2 * o) / (a.length + b.length - 2);
}
const fundNo = (t: string[]) => {
  // "i" behandlas som andelsklass, inte som romerskt 1, om det står sist efter en annan siffra
  for (let k = t.length - 1; k >= 0; k--) {
    const x = t[k];
    if (/^\d{1,2}$/.test(x)) return String(Number(x));
    if ((x.length > 1 || x === 'v' || x === 'x') && ROMAN.test(x)) return String(romanToInt(x));
  }
  return null;
};
function romanToInt(r: string) {
  const v: Record<string, number> = { i: 1, v: 5, x: 10 };
  let n = 0;
  for (let k = 0; k < r.length; k++) n += v[r[k]] < (v[r[k + 1]] ?? 0) ? -v[r[k]] : v[r[k]];
  return n;
}

/** Likhet 0–1 mellan två namn med hänsyn till fondnummer, vehikel och andelsklass. */
export function nameScore(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.length || !B.length) return 0;
  const na = fundNo(A);
  const nb = fundNo(B);
  if ((na || nb) && na !== nb) return na && nb ? 0 : 0.4; // olika eller saknat fondnummer
  const isQ = (t: string) => QUALIFIERS.has(t) || /^nr\d+$/.test(t); // "(No. 2)" = parallellt vehikel
  const qa = A.filter(isQ).sort().join(' ');
  const qb = B.filter(isQ).sort().join(' ');
  const ca = A.filter((t) => CLASS.has(t)).sort().join(' ');
  const cb = B.filter((t) => CLASS.has(t)).sort().join(' ');
  if (ca && cb && ca !== cb) return 0; // olika andelsklass/valuta
  const core = (t: string[]) => t.filter((x) => !isQ(x) && !CLASS.has(x) && !/^\d{1,2}$/.test(x) && !((x.length > 1 || x === 'v' || x === 'x') && ROMAN.test(x)));
  const CA = core(A);
  const CB = core(B);
  if (!CA.length || !CB.length) return 0;
  let shared = 0;
  for (const t of new Set(CA)) {
    if (CB.includes(t)) shared++;
    else if (CB.some((u) => dice(t, u) > 0.8)) shared += 0.8;
  }
  let score = (shared / Math.max(new Set(CA).size, new Set(CB).size)) * 0.7 + dice(CA.join(' '), CB.join(' ')) * 0.3;
  if (qa !== qb) score = Math.min(score, 0.55); // huvudfond vs parallell/feeder/co-invest
  if (Boolean(ca) !== Boolean(cb)) score = Math.min(score, 0.85); // andelsklass anges bara på ena sidan
  return score;
}

export interface Match {
  id: number | null;
  method: 'isin' | 'alias' | 'org_nr' | 'exact' | 'name' | 'single_holder' | 'only_entity' | 'manual' | 'none';
  score: number;
  label: string | null;
  confirmed: boolean;
  candidates: { id: number; name: string; score: number }[];
  /** Avsändaren stämmer med registrerad förvaltare */
  managerMatch?: boolean | null;
}

const SURE = 0.95;

function aliasLookup(kind: 'instrument' | 'entity', raw: string | null, issuer: string | null): number | null {
  if (!raw) return null;
  const key = normalize(raw);
  if (!key) return null;
  const iss = issuer ? normalize(issuer) : null;
  const r = get<{ target_id: number }>(
    'SELECT target_id FROM aliases WHERE kind=? AND alias=? AND (issuer IS NULL OR issuer=?) ORDER BY issuer IS NULL LIMIT 1', kind, key, iss,
  );
  return r?.target_id ?? null;
}

export function learnAlias(kind: 'instrument' | 'entity', raw: string | null, issuer: string | null, targetId: number, userId: number | null) {
  if (!raw) return false;
  const key = normalize(raw);
  if (!key) return false;
  const iss = issuer ? normalize(issuer) : null;
  const existing = get<{ id: number; target_id: number }>('SELECT id, target_id FROM aliases WHERE kind=? AND alias=? AND issuer IS ?', kind, key, iss);
  if (existing?.target_id === targetId) return false;
  if (existing) run('UPDATE aliases SET target_id=?, raw=?, created_by=?, created_at=datetime(\'now\') WHERE id=?', targetId, raw, userId, existing.id);
  else run('INSERT INTO aliases (kind, alias, raw, issuer, target_id, created_by) VALUES (?,?,?,?,?,?)', kind, key, raw, iss, targetId, userId);
  return true;
}

export function matchInstrument(
  doc: { name: string | null; isin: string | null; issuer: string | null },
  allowed: Instrument[],
): Match {
  const isin = (doc.isin ?? '').replace(/\s/g, '').toUpperCase();
  const base = { label: doc.name || isin || null, candidates: [] as Match['candidates'] };
  if (isin) {
    const hit = allowed.find((i) => i.isin === isin);
    if (hit) return { ...base, id: hit.id, method: 'isin', score: 1, confirmed: true, managerMatch: managerMatches(doc.issuer, hit) };
  }
  const aliased = aliasLookup('instrument', doc.name, doc.issuer);
  if (aliased && allowed.some((i) => i.id === aliased)) {
    return { ...base, id: aliased, method: 'alias', score: 1, confirmed: true, managerMatch: managerMatches(doc.issuer, allowed.find((i) => i.id === aliased)!) };
  }
  const name = doc.name ?? '';
  const scored = allowed
    .map((i) => ({ i, score: Math.max(nameScore(name, i.name), i.ticker ? nameScore(name, i.ticker) : 0), gp: managerMatches(doc.issuer, i) }))
    // Fonder från samma GP först vid lika poäng
    .map((x) => ({ ...x, rank: x.score + (x.gp ? 0.05 : 0) }))
    .sort((a, b) => b.rank - a.rank);
  const candidates = scored.filter((x) => x.score >= 0.35).slice(0, 4).map((x) => ({ id: x.i.id, name: x.i.name, score: Math.round(x.score * 100) / 100 }));
  const best = scored[0];
  if (best && best.score >= 0.6) {
    const exact = normalize(name) === normalize(best.i.name);
    const runnerUp = scored[1];
    const ambiguous = !!runnerUp && runnerUp.score >= best.score - 0.05;
    return {
      ...base, candidates, id: best.i.id, method: exact ? 'exact' : 'name', score: best.score,
      confirmed: (exact || best.score >= SURE) && !ambiguous, managerMatch: best.gp,
    };
  }
  return { ...base, candidates, id: null, method: 'none', score: best?.score ?? 0, confirmed: false };
}

function managerMatches(issuer: string | null, i: Instrument): boolean | null {
  if (!issuer || !i.manager) return null;
  return nameScore(issuer, i.manager) >= 0.6 || normalize(i.manager).includes(normalize(issuer)) || normalize(issuer).includes(normalize(i.manager));
}

export function matchEntity(label: string | null, issuer: string | null, instrumentId: number | null, entities: Entity[]): Match {
  const base = { label, candidates: [] as Match['candidates'] };
  const aliased = aliasLookup('entity', label, issuer);
  if (aliased && entities.some((e) => e.id === aliased)) return { ...base, id: aliased, method: 'alias', score: 1, confirmed: true };
  if (label) {
    const digits = label.replace(/\D/g, '');
    const byOrg = entities.find((e) => e.org_nr && digits.includes(e.org_nr.replace(/\D/g, '')));
    if (byOrg) return { ...base, id: byOrg.id, method: 'org_nr', score: 1, confirmed: true };
    // Investeraretiketter innehåller ofta kontonummer o.d.: "Demo Stiftelse (Investor ID 30042)"
    const nl = ` ${normalize(label)} `;
    const contained = entities.filter((e) => nl.includes(` ${normalize(e.name)} `)).sort((a, b) => b.name.length - a.name.length);
    if (contained.length) return { ...base, id: contained[0].id, method: 'exact', score: 1, confirmed: contained.length === 1 || contained[0].name.length > contained[1].name.length };
    const scored = entities.map((e) => ({ e, score: nameScore(label, e.name) })).sort((a, b) => b.score - a.score);
    const candidates = scored.filter((x) => x.score >= 0.35).slice(0, 4).map((x) => ({ id: x.e.id, name: x.e.name, score: Math.round(x.score * 100) / 100 }));
    if (scored[0] && scored[0].score >= 0.6) {
      const exact = normalize(label).startsWith(normalize(scored[0].e.name));
      return { ...base, candidates, id: scored[0].e.id, method: exact ? 'exact' : 'name', score: scored[0].score, confirmed: exact || scored[0].score >= SURE };
    }
    base.candidates = candidates;
  }
  if (instrumentId) {
    const holders = all<{ entity_id: number }>('SELECT DISTINCT entity_id FROM transactions WHERE instrument_id=?', instrumentId);
    if (holders.length === 1) return { ...base, id: holders[0].entity_id, method: 'single_holder', score: 0.5, confirmed: false };
  }
  if (entities.length === 1) return { ...base, id: entities[0].id, method: 'only_entity', score: 0.5, confirmed: false };
  return { ...base, id: null, method: 'none', score: 0, confirmed: false };
}

/** Avgör om en investeraretikett i ett dokument avser en viss enhet (org.nr, namn som ingår, eller hög namnlikhet). */
export function labelMatchesEntity(label: string, e: Entity): boolean {
  if (e.org_nr && label.replace(/\D/g, '').includes(e.org_nr.replace(/\D/g, ''))) return true;
  if (` ${normalize(label)} `.includes(` ${normalize(e.name)} `)) return true;
  return nameScore(label, e.name) >= 0.6;
}
