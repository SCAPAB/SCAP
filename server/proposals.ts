/**
 * Från AI-tolkning till godkända poster.
 *  1. buildProposals: gör om AI-svaret till förslag och matchar enhet + instrument.
 *  2. evaluate: deterministiska kontroller (dubbletter, summor, avstämning mot bokfört innehav …)
 *     och förhandsvisning av effekten – körs på nytt varje gång granskaren ändrar något.
 *  3. approve: skriver posten till databasen först när en människa har godkänt den.
 */
import { all, get, run, tx, audit, setting } from './db.ts';
import { matchInstrument, matchEntity, learnAlias, labelMatchesEntity, type Match } from './matching.ts';
export { nameScore } from './matching.ts';
import { HttpError } from './auth.ts';
import { getMarket, bumpVersion } from './data.ts';
import { listedHolding, peHolding, addDays, findOversell } from './calc.ts';
import { validateTransaction, insertTransaction, fxMissingMessage } from './validate.ts';
import type { ExtractionT } from './ai.ts';
import type { Entity, Instrument, InstrumentType, Transaction } from '../shared/types.ts';

export type Kind = 'BUY' | 'SELL' | 'DIVIDEND' | 'FEE' | 'COMMITMENT' | 'CALL' | 'DISTRIBUTION' | 'NAV' | 'PRICE' | 'HOLDING';
export type Confidence = 'high' | 'medium' | 'low';

export interface PField {
  value: string | number | null;
  ai_value: string | number | null; // vad AI:n föreslog (null för manuella)
  confidence: Confidence | null;
  page: number | null;
  quote: string | null;
  edited: boolean;
  confirmed: boolean; // granskaren har bekräftat ett osäkert AI-värde
}
/**
 * Delposter i kapitalanrop och utdelningar. Kategorin styr bokföringen:
 *  investment   – investering, ingår i åtagandet och ökar NAV
 *  mgmt_fee     – förvaltningsavgift, ingår i åtagandet, påverkar inte NAV
 *  expenses     – fondkostnader, ingår i åtagandet, påverkar inte NAV
 *  equalisation – utjämningsränta m.m. UTANFÖR åtagandet (minskar inte outnyttjat)
 *  return_of_capital – återbetalt kapital
 *  recallable   – återbetalt kapital som får anropas igen (ökar outnyttjat åtagande)
 *  gain / income – realiserad vinst / ränta och utdelning
 *  withholding  – källskatt eller annat avdrag (dras från utbetalningen)
 */
export type LineCategory = 'investment' | 'mgmt_fee' | 'expenses' | 'equalisation' | 'return_of_capital' | 'recallable' | 'gain' | 'income' | 'withholding';
export const LINE_CATEGORIES: Record<'CALL' | 'DISTRIBUTION', LineCategory[]> = {
  CALL: ['investment', 'mgmt_fee', 'expenses', 'equalisation'],
  DISTRIBUTION: ['return_of_capital', 'recallable', 'gain', 'income', 'withholding'],
};
export interface LineItem { description: string; amount: number; category: LineCategory; page: number | null }

/** Summerar delposter till de belopp som bokförs. */
export function splitLines(lines: LineItem[]) {
  const sum = (c: LineCategory[]) => lines.filter((l) => c.includes(l.category)).reduce((a, l) => a + l.amount, 0);
  return {
    total: lines.reduce((a, l) => a + l.amount, 0),
    investment: sum(['investment']),
    fees: sum(['mgmt_fee', 'expenses', 'equalisation']),
    outside: sum(['equalisation']),
    gross: sum(['return_of_capital', 'recallable', 'gain', 'income']),
    withholding: sum(['withholding']),
    recallable: sum(['recallable']),
  };
}

/** Bakåtkompatibel tolkning av äldre delposter (affects_nav) och AI-svar. */
export function normalizeLines(kind: Kind, raw: unknown[] | null): LineItem[] | null {
  if (!raw || !raw.length) return null;
  return raw.map((r) => {
    const l = r as { description?: string; amount?: number; category?: LineCategory; affects_nav?: boolean; page?: number | null };
    let category = l.category;
    if (!category || !(LINE_CATEGORIES[kind as 'CALL'] ?? []).includes(category)) {
      category = kind === 'CALL' ? (l.affects_nav === false ? 'mgmt_fee' : 'investment') : 'return_of_capital';
    }
    return { description: String(l.description ?? ''), amount: Math.abs(Number(l.amount) || 0), category, page: l.page ?? null };
  });
}

export interface ProposalRow {
  id: number; document_id: number; seq: number; kind: Kind; origin: 'ai' | 'manual'; status: 'pending' | 'approved' | 'rejected';
  entity_id: number | null; instrument_id: number | null; match: string | null; fields: string; line_items: string | null;
  result_ref: string | null; decided_by: number | null; decided_at: string | null; comment: string | null;
  prepared_by: number | null; prepared_at: string | null;
}

export interface Check { level: 'error' | 'warning' | 'ok' | 'info'; code: string; message: string }

/** Vilka fält som hör till varje typ av post. Stjärnmärkta (*) är obligatoriska. */
export const KIND_FIELDS: Record<Kind, string[]> = {
  CALL: ['date*', 'settle_date', 'amount*', 'fee', 'outside_commitment', 'fx_rate', 'currency', 'note'],
  DISTRIBUTION: ['date*', 'settle_date', 'amount*', 'fee', 'recallable', 'fx_rate', 'currency', 'note'],
  COMMITMENT: ['date*', 'amount*', 'currency', 'note'],
  NAV: ['date*', 'amount*', 'currency', 'commitment_total', 'paid_in_total', 'unfunded', 'distributed_total', 'note'],
  BUY: ['date*', 'settle_date', 'quantity*', 'price*', 'amount', 'fee', 'fx_rate', 'currency', 'note'],
  SELL: ['date*', 'settle_date', 'quantity*', 'price*', 'amount', 'fee', 'fx_rate', 'currency', 'note'],
  DIVIDEND: ['date*', 'quantity', 'price', 'amount*', 'fee', 'fx_rate', 'currency', 'note'],
  FEE: ['date*', 'amount*', 'fx_rate', 'currency', 'note'],
  PRICE: ['date*', 'price*', 'currency'],
  HOLDING: ['date*', 'quantity*', 'price', 'amount', 'currency'],
};
const NUMERIC = new Set(['amount', 'fee', 'quantity', 'price', 'fx_rate', 'commitment_total', 'paid_in_total', 'unfunded', 'distributed_total', 'outside_commitment', 'recallable']);
export const KIND_TYPES: Record<Kind, InstrumentType[]> = {
  CALL: ['PE_FUND'], DISTRIBUTION: ['PE_FUND'], COMMITMENT: ['PE_FUND'], NAV: ['PE_FUND'],
  BUY: ['EQUITY', 'FUND'], SELL: ['EQUITY', 'FUND'], DIVIDEND: ['EQUITY', 'FUND'], PRICE: ['EQUITY', 'FUND'], HOLDING: ['EQUITY', 'FUND'],
  FEE: ['EQUITY', 'FUND', 'PE_FUND'],
};

const fieldNames = (k: Kind) => KIND_FIELDS[k].map((f) => f.replace('*', ''));
const required = (k: Kind) => KIND_FIELDS[k].filter((f) => f.endsWith('*')).map((f) => f.slice(0, -1));

// ---------------------------------------------------------------------------
// 1. Skapa förslag
// ---------------------------------------------------------------------------

const toField = (f: { value: unknown; confidence: Confidence; page: number | null; quote: string | null } | undefined, numeric: boolean): PField => {
  let v = f?.value ?? null;
  if (numeric && typeof v === 'number') v = Math.abs(v);
  return { value: v as PField['value'], ai_value: v as PField['value'], confidence: v == null ? null : f!.confidence, page: f?.page ?? null, quote: f?.quote ?? null, edited: false, confirmed: false };
};
export const emptyField = (value: PField['value'] = null): PField => ({ value, ai_value: null, confidence: null, page: null, quote: null, edited: false, confirmed: false });

export function buildProposals(documentId: number, ex: ExtractionT) {
  const entities = all<Entity>('SELECT id, name, org_nr FROM entities');
  const issuer = ex.issuer.value;
  const instruments = all<Instrument>('SELECT * FROM instruments');
  run("DELETE FROM proposals WHERE document_id=? AND status='pending' AND origin='ai'", documentId);
  const start = (get<{ n: number }>('SELECT COALESCE(MAX(seq),0) n FROM proposals WHERE document_id=?', documentId)?.n ?? 0) + 1;
  ex.items.forEach((item, i) => {
    const kind = item.kind as Kind;
    const fields: Record<string, PField> = {};
    for (const f of fieldNames(kind)) {
      const src = (item as unknown as Record<string, { value: unknown; confidence: Confidence; page: number | null; quote: string | null }>)[f];
      fields[f] = f === 'note' ? { ...emptyField(item.note), ai_value: item.note }
        : f === 'fx_rate' || f === 'outside_commitment' || f === 'recallable' ? emptyField()
          : toField(src, NUMERIC.has(f));
    }
    fields.instrument_name = toField(item.instrument_name, false);
    fields.isin = toField(item.isin, false);
    fields.investor_label = toField(item.investor_label.value ? item.investor_label : ex.investor_label, false);
    const im = matchInstrument({ name: item.instrument_name.value, isin: item.isin.value, issuer }, instruments.filter((x) => KIND_TYPES[kind].includes(x.type)));
    const em = matchEntity(str(fields.investor_label), issuer, im.id, entities);
    const lines = normalizeLines(kind, item.line_items);
    if (lines && kind === 'CALL') { const sp = splitLines(lines); if (sp.outside) fields.outside_commitment = { ...emptyField(sp.outside), ai_value: sp.outside, confidence: 'medium' }; }
    if (lines && kind === 'DISTRIBUTION') { const sp = splitLines(lines); if (sp.recallable) fields.recallable = { ...emptyField(sp.recallable), ai_value: sp.recallable, confidence: 'medium' }; }
    run(
      'INSERT INTO proposals (document_id, seq, kind, origin, entity_id, instrument_id, match, fields, line_items) VALUES (?,?,?,?,?,?,?,?,?)',
      documentId, start + i, kind, 'ai', em.id, im.id, JSON.stringify({ entity: em, instrument: im }), JSON.stringify(fields), lines ? JSON.stringify(lines) : null,
    );
  });
}

/** Skapar en köp/sälj-post för differensen mellan innehavsbesked och bokfört innehav. */
export function proposeHoldingFix(id: number) {
  const p = get<ProposalRow>('SELECT * FROM proposals WHERE id=?', id);
  if (!p || p.kind !== 'HOLDING' || !p.entity_id || !p.instrument_id) throw new HttpError(400, 'Förslaget är ingen avstämning med vald enhet och instrument');
  const f = JSON.parse(p.fields) as Record<string, PField>;
  const date = str(f.date);
  const qty = num(f.quantity);
  if (!date || qty == null) throw new HttpError(400, 'Datum och antal krävs');
  const ins = get<Instrument>('SELECT * FROM instruments WHERE id=?', p.instrument_id)!;
  const book = listedHolding(ins, p.entity_id, all<Transaction>('SELECT * FROM transactions WHERE entity_id=? AND instrument_id=?', p.entity_id, p.instrument_id), getMarket(), date).quantity;
  const diff = qty - book;
  if (Math.abs(diff) < 1e-9) throw new HttpError(400, 'Ingen differens att rätta');
  const kind: Kind = diff > 0 ? 'BUY' : 'SELL';
  const newId = createManualProposal(p.document_id, kind);
  const nf = JSON.parse(get<ProposalRow>('SELECT * FROM proposals WHERE id=?', newId)!.fields) as Record<string, PField>;
  nf.date = { ...emptyField(date), edited: true };
  nf.quantity = { ...emptyField(Math.abs(diff)), edited: true };
  if (num(f.price) != null) nf.price = { ...emptyField(num(f.price)), edited: true };
  nf.note = { ...emptyField(`Avstämning mot innehavsbesked: differens ${fmt(diff, 4)} st. Kontrollera affärsdag och kurs mot avräkningsnotan.`), edited: true };
  run('UPDATE proposals SET entity_id=?, instrument_id=?, fields=? WHERE id=?', p.entity_id, p.instrument_id, JSON.stringify(nf), newId);
  return newId;
}

export function createManualProposal(documentId: number, kind: Kind) {
  const fields: Record<string, PField> = {};
  for (const f of fieldNames(kind)) fields[f] = emptyField();
  fields.instrument_name = emptyField();
  fields.isin = emptyField();
  fields.investor_label = emptyField();
  const seq = (get<{ n: number }>('SELECT COALESCE(MAX(seq),0) n FROM proposals WHERE document_id=?', documentId)?.n ?? 0) + 1;
  const r = run('INSERT INTO proposals (document_id, seq, kind, origin, fields) VALUES (?,?,?,?,?)', documentId, seq, kind, 'manual', JSON.stringify(fields));
  return Number(r.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// 2. Kontroller och förhandsvisning
// ---------------------------------------------------------------------------

const num = (f?: PField) => (f?.value == null || f.value === '' ? null : Number(f.value));
const str = (f?: PField) => (f?.value == null ? null : String(f.value).trim() || null);
const fmt = (n: number | null | undefined, d = 0) => (n == null || !isFinite(n) ? '–' : n.toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d }));
const isDate = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

export interface Evaluated {
  checks: Check[];
  preview: { label: string; before: string; after: string }[];
  canApprove: boolean;
  blocking: string[];
  needsAck: boolean;
}

export function evaluate(p: ProposalRow, docId: number): Evaluated {
  const fields = JSON.parse(p.fields) as Record<string, PField>;
  const lines = normalizeLines(p.kind, p.line_items ? JSON.parse(p.line_items) : null);
  const match = (p.match ? JSON.parse(p.match) : {}) as { entity?: Match; instrument?: Match };
  const checks: Check[] = [];
  const preview: Evaluated['preview'] = [];
  const kind = p.kind;
  const ins = p.instrument_id ? get<Instrument>('SELECT * FROM instruments WHERE id=?', p.instrument_id) : undefined;
  const ent = p.entity_id ? get<Entity>('SELECT * FROM entities WHERE id=?', p.entity_id) : undefined;

  const amount = num(fields.amount);
  const fee = num(fields.fee) ?? 0;
  const qty = num(fields.quantity);
  const price = num(fields.price);

  // Grundkrav
  if (!ent) checks.push({ level: 'error', code: 'entity', message: 'Välj juridisk enhet' });
  if (!ins) checks.push({ level: 'error', code: 'instrument', message: 'Välj instrument (eller skapa ett nytt)' });
  if (ins && !KIND_TYPES[kind].includes(ins.type)) checks.push({ level: 'error', code: 'kind', message: `Posttypen passar inte för ${ins.name}` });
  // Matchningar som inte är säkra måste bekräftas av granskaren
  const mi = match.instrument;
  if (ins && mi && mi.id === ins.id && !mi.confirmed) {
    checks.push({ level: 'error', code: 'confirm_instrument', message: `Bekräfta instrument: "${mi.label}" i dokumentet → ${ins.name} (likhet ${Math.round(mi.score * 100)} %)` });
  } else if (ins && mi && (mi.method === 'isin' || mi.method === 'alias')) {
    checks.push({ level: 'ok', code: 'match_instrument', message: mi.method === 'isin' ? `Instrumentet matchat på ISIN` : `Instrumentet känt från tidigare godkänt underlag ("${mi.label}")` });
  }
  if (ins && mi?.managerMatch === false) {
    const doc = get<{ issuer: string | null }>('SELECT issuer FROM documents WHERE id=?', docId);
    checks.push({ level: 'warning', code: 'manager', message: `Avsändaren "${doc?.issuer}" är inte registrerad förvaltare för ${ins.name} (${ins.manager})` });
  }
  const me = match.entity;
  if (ent && me && me.id === ent.id && !me.confirmed) {
    checks.push({ level: 'error', code: 'confirm_entity', message: me.label
      ? `Dokumentet anger investeraren "${me.label}", som inte motsvarar ${ent.name}. Bekräfta att posten gäller ${ent.name} – annars avvisa den.`
      : `Investeraren framgår inte av dokumentet. Bekräfta att posten gäller ${ent.name}.` });
  }
  // PE: enheten ska ha ett åtagande i fonden
  if (ins && ent && ins.type === 'PE_FUND' && kind !== 'COMMITMENT' && !get("SELECT 1 FROM transactions WHERE entity_id=? AND instrument_id=? AND type='COMMITMENT'", ent.id, ins.id)) {
    checks.push({ level: 'warning', code: 'no_commitment', message: `${ent.name} har inget registrerat åtagande i ${ins.name} – kontrollera enhet och fond, eller registrera åtagandet först` });
  }
  for (const f of required(kind)) {
    const v = fields[f]?.value;
    if (v == null || v === '') checks.push({ level: 'error', code: `missing_${f}`, message: `${LABELS[f] ?? f} saknas` });
  }
  const date = str(fields.date);
  if (date && !isDate(date)) checks.push({ level: 'error', code: 'date', message: 'Datum har fel format (ÅÅÅÅ-MM-DD)' });
  if (date && isDate(date) && date > new Date().toISOString().slice(0, 10) && kind !== 'CALL' && kind !== 'DISTRIBUTION') {
    checks.push({ level: 'warning', code: 'future', message: `Datumet ${date} ligger i framtiden` });
  }
  for (const f of Object.keys(fields)) {
    if (!NUMERIC.has(f) || fields[f].value == null || fields[f].value === '') continue;
    const v = Number(fields[f].value);
    if (!isFinite(v)) checks.push({ level: 'error', code: `nan_${f}`, message: `${LABELS[f] ?? f} är inte ett tal` });
    else if (v < 0) checks.push({ level: 'error', code: `neg_${f}`, message: `${LABELS[f] ?? f} får inte vara negativt (${fmt(v, 2)})` });
  }
  // Belopp, antal och kurs som bokförs måste vara större än 0 (samma krav som vid manuell registrering)
  const positive = (k: string, label = LABELS[k] ?? k) => {
    const v = num(fields[k]);
    if (v != null && isFinite(v) && v === 0) checks.push({ level: 'error', code: `zero_${k}`, message: `${label} måste vara större än 0` });
  };
  if (TX_KINDS.includes(kind)) positive('amount');
  if (kind === 'BUY' || kind === 'SELL') { positive('quantity'); positive('price'); }
  if (kind === 'PRICE') positive('price');
  // Osäkra AI-värden måste bekräftas eller ändras
  const unsure = Object.entries(fields).filter(([, f]) => f.confidence === 'low' && !f.edited && !f.confirmed && f.value != null);
  for (const [k] of unsure) checks.push({ level: 'error', code: `confirm_${k}`, message: `Bekräfta osäkert AI-värde: ${LABELS[k] ?? k}` });

  const ccy = str(fields.currency)?.toUpperCase();
  if (ins && ccy && ccy !== ins.currency) checks.push({ level: 'error', code: 'currency', message: `Valutan i dokumentet (${ccy}) skiljer sig från instrumentets (${ins.currency})` });

  // Investerare enligt dokumentet vs vald enhet
  const inv = str(fields.investor_label);
  if (ent && inv && me?.confirmed !== false) {
    if (labelMatchesEntity(inv, ent)) checks.push({ level: 'ok', code: 'investor', message: `Investeraren i dokumentet ("${inv}") matchar ${ent.name}` });
    else checks.push({ level: 'warning', code: 'investor', message: `Dokumentet gäller "${inv}" – kontrollera att ${ent.name} är rätt enhet` });
  }


  // Valutakurs: högst 7 dagar före affärsdagen, aldrig en senare kurs
  if (ins && ins.currency !== 'SEK' && date && isDate(date) && ['CALL', 'DISTRIBUTION', 'BUY', 'SELL', 'DIVIDEND', 'FEE'].includes(kind) && !num(fields.fx_rate)) {
    const r = getMarket().fxForTrade(ins.currency, date);
    if (!r) checks.push({ level: 'error', code: 'fx', message: fxMissingMessage(ins.currency, date) });
    else checks.push({ level: 'info', code: 'fx', message: `Valutakurs ${fmt(r.value, 4)} SEK/${ins.currency} per ${r.date} hämtas från registrerade kurser${r.date < date ? ` (senaste kurs före affärsdagen ${date})` : ''}` });
  }
  if (kind === 'CALL' && amount != null && fee > amount + 1e-9) checks.push({ level: 'error', code: 'fee_total', message: `Avgifterna (${fmt(fee, 2)}) är större än det totala anropade beloppet (${fmt(amount, 2)}). Belopp ska vara totalt anropat enligt avin, avgift = varav avgifter.` });

  // Delposter ska summera till totalen och avgiftsdelen stämma
  if (lines && lines.length && amount != null && (kind === 'CALL' || kind === 'DISTRIBUTION')) {
    const sp = splitLines(lines);
    const tol = Math.max(1, amount * 0.0001);
    const lineTotal = kind === 'CALL' ? sp.total : sp.gross;
    if (Math.abs(lineTotal - amount) > tol) checks.push({ level: 'warning', code: 'lines_sum', message: `Delposterna summerar till ${fmt(lineTotal, 2)} men beloppet är ${fmt(amount, 2)}` });
    else checks.push({ level: 'ok', code: 'lines_sum', message: 'Delposterna summerar till beloppet' });
    const feeLines = kind === 'CALL' ? sp.fees : sp.withholding;
    if (Math.abs(feeLines - fee) > tol) checks.push({ level: 'warning', code: 'fee_split', message: `${kind === 'CALL' ? 'Avgifter' : 'Avdrag'} enligt delposterna (${fmt(feeLines, 2)}) skiljer sig från fältet (${fmt(fee, 2)})` });
    if (kind === 'CALL' && sp.outside && Math.abs(sp.outside - (num(fields.outside_commitment) ?? 0)) > tol) checks.push({ level: 'warning', code: 'outside_split', message: `Utjämningsränta enligt delposterna (${fmt(sp.outside, 2)}) skiljer sig från fältet "utanför åtagandet"` });
    if (kind === 'DISTRIBUTION' && sp.recallable && Math.abs(sp.recallable - (num(fields.recallable) ?? 0)) > tol) checks.push({ level: 'warning', code: 'recallable_split', message: `Återinkallningsbart enligt delposterna (${fmt(sp.recallable, 2)}) skiljer sig från fältet` });
  }

  // Köp/sälj: antal × kurs ska stämma med likvidbelopp
  if ((kind === 'BUY' || kind === 'SELL') && qty && price && amount) {
    const calc = qty * price;
    if (Math.abs(calc - amount) / amount > 0.005) checks.push({ level: 'warning', code: 'qty_price', message: `Antal × kurs = ${fmt(calc, 2)}, men likvidbeloppet är ${fmt(amount, 2)}` });
    else checks.push({ level: 'ok', code: 'qty_price', message: 'Antal × kurs stämmer med likvidbeloppet' });
  }

  // Dubbletter: samma enhet, instrument, typ, datum och belopp
  if (ins && ent && date && isDate(date)) {
    if (['CALL', 'DISTRIBUTION', 'BUY', 'SELL', 'DIVIDEND', 'FEE', 'COMMITMENT'].includes(kind)) {
      const near = all<Transaction>(
        'SELECT * FROM transactions WHERE entity_id=? AND instrument_id=? AND type=? AND trade_date BETWEEN ? AND ?',
        ent.id, ins.id, kind, addDays(date, -5), addDays(date, 5),
      ).filter((t) => {
        const total = t.amount + (t.type === 'CALL' ? t.fee : 0); // kapitalanrop bokas som investering + avgift
        return amount == null || Math.abs(total - amount) <= Math.max(1, amount * 0.005) || (qty != null && qty > 0 && Math.abs(t.quantity - qty) < 1e-9);
      });
      if (near.length) checks.push({ level: 'warning', code: 'duplicate', message: `Möjlig dubblett: liknande transaktion finns redan ${near[0].trade_date} (#${near[0].id})` });
      else checks.push({ level: 'ok', code: 'duplicate', message: 'Ingen liknande transaktion finns sedan tidigare' });
    }
    if (kind === 'NAV' && get('SELECT 1 FROM pe_valuations WHERE entity_id=? AND instrument_id=? AND date=?', ent.id, ins.id, date)) {
      checks.push({ level: 'warning', code: 'nav_exists', message: `Det finns redan ett NAV per ${date} – det ersätts vid godkännande` });
    }
    if (kind === 'PRICE' && get('SELECT 1 FROM prices WHERE instrument_id=? AND date=?', ins.id, date)) {
      checks.push({ level: 'info', code: 'price_exists', message: `Kurs per ${date} finns redan och ersätts` });
    }
  }

  // Effekt och avstämning mot bokfört innehav
  if (ins && ent && date && isDate(date)) {
    const m = getMarket();
    const txs = all<Transaction>('SELECT * FROM transactions WHERE entity_id=? AND instrument_id=?', ent.id, ins.id);
    if (ins.type === 'PE_FUND') {
      const asOf = date;
      const before = peHolding(ins, ent.id, txs, m, asOf);
      if (kind === 'CALL' && amount != null) {
        if (before.commitment > 0 && amount > before.uncalled + 1) checks.push({ level: 'warning', code: 'over_commit', message: `Anropet (${fmt(amount)}) överstiger outnyttjat åtagande (${fmt(before.uncalled)})` });
        else if (before.commitment > 0) checks.push({ level: 'ok', code: 'over_commit', message: `Ryms inom outnyttjat åtagande (${fmt(before.uncalled)} ${ins.currency})` });
        else checks.push({ level: 'warning', code: 'no_commit', message: 'Inget åtagande är registrerat för enheten i denna fond' });
      }
      if (kind === 'DISTRIBUTION' && amount != null && before.paidIn === 0) checks.push({ level: 'warning', code: 'dist_no_paid', message: 'Utdelning registreras men inget kapital har betalats in' });
      if (kind === 'NAV' && amount != null) {
        const prev = all<{ date: string; nav: number }>('SELECT date, nav FROM pe_valuations WHERE entity_id=? AND instrument_id=? AND date < ? ORDER BY date DESC LIMIT 1', ent.id, ins.id, date)[0];
        if (prev) {
          const flows = txs.filter((t) => t.trade_date > prev.date && t.trade_date <= date).reduce((a, t) => a + (t.type === 'CALL' ? t.amount : t.type === 'DISTRIBUTION' ? -(t.amount - t.fee) : 0), 0);
          const expected = prev.nav + flows;
          const chg = expected > 0 ? amount / expected - 1 : null;
          if (chg != null && Math.abs(chg) > 0.25) checks.push({ level: 'warning', code: 'nav_jump', message: `NAV avviker ${fmt(chg * 100, 1)} % från förra rapporten (${prev.date}) justerad för flöden` });
          else if (chg != null) checks.push({ level: 'ok', code: 'nav_jump', message: `Värdeförändring ${fmt(chg * 100, 1)} % sedan förra rapporten (${prev.date}), justerat för flöden` });
        }
        // Avstämning mot kapitalkontot
        const rec: [string, number | null, number][] = [
          ['Åtagande', num(fields.commitment_total), before.commitment],
          ['Inbetalt', num(fields.paid_in_total), before.paidIn],
          ['Utdelat', num(fields.distributed_total), before.distributed],
          ['Outnyttjat', num(fields.unfunded), before.uncalled],
        ];
        for (const [label, docV, book] of rec) {
          if (docV == null) continue;
          const diff = docV - book;
          if (Math.abs(diff) <= Math.max(1, Math.abs(book) * 0.001)) checks.push({ level: 'ok', code: `rec_${label}`, message: `${label} stämmer med bokföringen (${fmt(book)})` });
          else checks.push({ level: 'warning', code: `rec_${label}`, message: `${label}: dokumentet ${fmt(docV)}, bokfört ${fmt(book)} – differens ${fmt(diff)}` });
        }
      }
      // Förhandsvisning
      const hypo = hypothetical(p, fields, ins, ent.id, date);
      if (hypo || kind === 'NAV') {
        const after = kind === 'NAV'
          ? { ...before, nav: amount ?? before.nav }
          : peHolding(ins, ent.id, [...txs, hypo!], m, asOf);
        const ccyS = ` ${ins.currency}`;
        if (kind === 'COMMITMENT') preview.push({ label: 'Åtagande', before: fmt(before.commitment) + ccyS, after: fmt(after.commitment) + ccyS });
        if (kind === 'CALL' || kind === 'FEE') preview.push({ label: 'Inbetalt', before: fmt(before.paidIn) + ccyS, after: fmt(after.paidIn) + ccyS });
        if (kind === 'CALL' || kind === 'COMMITMENT' || (kind === 'DISTRIBUTION' && after.uncalled !== before.uncalled)) preview.push({ label: 'Outnyttjat åtagande', before: fmt(before.uncalled) + ccyS, after: fmt(after.uncalled) + ccyS });
        if (kind === 'DISTRIBUTION') preview.push({ label: 'Utdelat', before: fmt(before.distributed) + ccyS, after: fmt(after.distributed) + ccyS });
        preview.push({ label: kind === 'NAV' ? 'NAV' : 'NAV (framräknat)', before: fmt(before.nav) + ccyS, after: fmt(after.nav) + ccyS });
        if (kind !== 'NAV' && kind !== 'COMMITMENT' && 'dpi' in after) preview.push({ label: 'DPI', before: fmt(before.dpi, 2) + 'x', after: fmt(after.dpi, 2) + 'x' });
      }
    } else {
      const before = listedHolding(ins, ent.id, txs, m, date);
      if (kind === 'SELL' && qty != null && qty > before.quantity + 1e-9) checks.push({ level: 'error', code: 'oversell', message: `Försäljningen (${fmt(qty, 4)}) överstiger innehavet per ${date} (${fmt(before.quantity, 4)})` });
      else if ((kind === 'SELL' || kind === 'BUY') && qty != null && qty > 0) {
        // Hela tidslinjen: en bakdaterad försäljning får inte göra en senare försäljning omöjlig
        const bad = findOversell([...txs, { id: Number.MAX_SAFE_INTEGER, trade_date: date, type: kind, quantity: qty }]);
        if (bad) checks.push({ level: 'error', code: 'oversell', message: `Försäljningen ${bad.date} (${fmt(bad.quantity, 4)} st) överstiger innehavet (${fmt(bad.held, 4)} st) per den dagen` });
      }
      if (kind === 'HOLDING' && qty != null) {
        const diff = qty - before.quantity;
        if (Math.abs(diff) < 1e-6) checks.push({ level: 'ok', code: 'reconcile', message: `Antal stämmer med bokfört innehav (${fmt(before.quantity, 4)})` });
        else checks.push({ level: 'warning', code: 'reconcile', message: `Avvikelse: dokumentet ${fmt(qty, 4)} st, bokfört ${fmt(before.quantity, 4)} st (differens ${fmt(diff, 4)}). Registrera saknade transaktioner.` });
      }
      if (kind === 'PRICE' || (kind === 'HOLDING' && price != null)) {
        const last = m.price(ins.id, addDays(date, -1));
        if (last && price) {
          const chg = price / last.value - 1;
          if (Math.abs(chg) > 0.2) checks.push({ level: 'warning', code: 'price_jump', message: `Kursen avviker ${fmt(chg * 100, 1)} % från senaste kurs (${fmt(last.value, 4)} per ${last.date})` });
          else checks.push({ level: 'ok', code: 'price_jump', message: `Rimlig kursförändring (${fmt(chg * 100, 1)} % sedan ${last.date})` });
        }
      }
      const hypo = hypothetical(p, fields, ins, ent.id, date);
      if (hypo) {
        const after = listedHolding(ins, ent.id, [...txs, hypo], m, date);
        preview.push({ label: 'Antal', before: fmt(before.quantity, 4), after: fmt(after.quantity, 4) });
        if (kind === 'BUY' || kind === 'SELL') preview.push({ label: `GAV (${ins.currency})`, before: fmt(before.avgCostLocal, 4), after: fmt(after.avgCostLocal, 4) });
        preview.push({ label: 'Anskaffningsvärde SEK', before: fmt(before.costBase), after: fmt(after.costBase) });
        if (kind === 'SELL') preview.push({ label: 'Realiserat resultat SEK', before: fmt(before.realizedBase), after: fmt(after.realizedBase) });
        if (kind === 'DIVIDEND') preview.push({ label: 'Utdelningar SEK', before: fmt(before.dividendsBase), after: fmt(after.dividendsBase) });
      }
    }
  }

  // Sista kontroll: samma validering som vid manuell registrering
  if (TX_KINDS.includes(kind) && ins && ent && date && isDate(date) && !checks.some((c) => c.level === 'error')) {
    try {
      validateTransaction(txBody(p, fields));
    } catch (e) {
      checks.push({ level: 'error', code: 'validate', message: (e as Error).message });
    }
  }

  const blocking = checks.filter((c) => c.level === 'error').map((c) => c.message);
  return { checks, preview, blocking, canApprove: blocking.length === 0 && p.status === 'pending', needsAck: checks.some((c) => c.level === 'warning') };
}

const TX_KINDS: Kind[] = ['CALL', 'DISTRIBUTION', 'BUY', 'SELL', 'DIVIDEND', 'FEE', 'COMMITMENT'];

/** Förslaget som indata till validateTransaction (kapitalanrop: amount = totalt anropat, fee = varav avgifter). */
function txBody(p: ProposalRow, f: Record<string, PField>): Record<string, unknown> {
  return {
    entity_id: p.entity_id, instrument_id: p.instrument_id, type: p.kind, trade_date: str(f.date), settle_date: str(f.settle_date),
    quantity: num(f.quantity), price: num(f.price), amount: num(f.amount), fee: num(f.fee), fx_rate: num(f.fx_rate), note: str(f.note),
    outside_commitment: num(f.outside_commitment), recallable: num(f.recallable),
  };
}

/** Transaktionen som skulle skapas (utan att spara). */
function hypothetical(p: ProposalRow, f: Record<string, PField>, ins: Instrument, entityId: number, date: string): Transaction | null {
  if (!TX_KINDS.includes(p.kind)) return null;
  const amount = num(f.amount);
  const qty = num(f.quantity) ?? 0;
  const price = num(f.price) ?? 0;
  const fee = num(f.fee) ?? 0;
  const amt = amount ?? (p.kind === 'BUY' || p.kind === 'SELL' ? qty * price : null);
  if (amt == null || !isFinite(amt)) return null;
  const fx = num(f.fx_rate) ?? getMarket().fxForTrade(ins.currency, date)?.value ?? 1; // endast förhandsvisning
  // Kapitalanrop: amount i transaktionen = investeringsdelen, fee = avgiftsdelen
  const isCall = p.kind === 'CALL';
  const outside = isCall ? num(f.outside_commitment) ?? 0 : 0;
  const recallable = p.kind === 'DISTRIBUTION' ? num(f.recallable) ?? 0 : 0;
  return {
    outside_commitment: outside, recallable,
    id: 1e12, entity_id: entityId, instrument_id: ins.id, type: p.kind as Transaction['type'], trade_date: date, settle_date: str(f.settle_date),
    quantity: p.kind === 'BUY' || p.kind === 'SELL' ? qty : 0, price, amount: isCall ? amt - fee : amt, fee: p.kind === 'COMMITMENT' ? 0 : fee, fx_rate: fx, note: null,
  };
}

export const LABELS: Record<string, string> = {
  date: 'Datum', settle_date: 'Likviddag', amount: 'Belopp', fee: 'Avgift', fx_rate: 'Valutakurs', currency: 'Valuta', note: 'Notering',
  quantity: 'Antal', price: 'Kurs', commitment_total: 'Åtagande enligt dokument', paid_in_total: 'Inbetalt enligt dokument',
  unfunded: 'Outnyttjat enligt dokument', distributed_total: 'Utdelat enligt dokument', instrument_name: 'Instrument i dokumentet', isin: 'ISIN',
  investor_label: 'Investerare i dokumentet',
  outside_commitment: 'Varav utanför åtagandet', recallable: 'Varav återinkallningsbart',
};

// ---------------------------------------------------------------------------
// 3. Godkänn
// ---------------------------------------------------------------------------

export function approve(id: number, userId: number | null, opts: { acknowledgeWarnings: boolean; comment?: string | null }) {
  const p = get<ProposalRow>('SELECT * FROM proposals WHERE id=?', id);
  if (!p) throw new HttpError(404, 'Förslaget finns inte');
  if (p.status !== 'pending') throw new HttpError(409, 'Förslaget är redan hanterat');
  const ev = evaluate(p, p.document_id);
  if (ev.blocking.length) throw new HttpError(400, ev.blocking.join(' · '));
  if (ev.needsAck && !opts.acknowledgeWarnings) throw new HttpError(400, 'Bekräfta att du har kontrollerat varningarna');
  if (dualControl()) {
    if (!p.prepared_by) throw new HttpError(400, 'Fyra ögon-principen: posten måste först markeras som granskad');
    if (p.prepared_by === userId) throw new HttpError(403, 'Fyra ögon-principen: en annan användare än den som granskade måste attestera');
  }
  const f = JSON.parse(p.fields) as Record<string, PField>;
  const lines = normalizeLines(p.kind, p.line_items ? JSON.parse(p.line_items) : null);
  const date = str(f.date)!;
  let ref = '';
  tx(() => {
    switch (p.kind) {
      case 'NAV':
        run(`INSERT INTO pe_valuations (entity_id,instrument_id,date,nav,source,document_id) VALUES (?,?,?,?,?,?)
             ON CONFLICT(entity_id,instrument_id,date) DO UPDATE SET nav=excluded.nav, source=excluded.source, document_id=excluded.document_id`,
        p.entity_id, p.instrument_id, date, num(f.amount), 'Dokument', p.document_id);
        ref = `valuation:${p.entity_id}:${p.instrument_id}:${date}`;
        break;
      case 'PRICE':
        run('INSERT INTO prices (instrument_id,date,price,source) VALUES (?,?,?,?) ON CONFLICT(instrument_id,date) DO UPDATE SET price=excluded.price, source=excluded.source', p.instrument_id, date, num(f.price), `Dokument #${p.document_id}`);
        ref = `price:${p.instrument_id}:${date}`;
        break;
      case 'HOLDING':
        if (num(f.price) != null) {
          run('INSERT INTO prices (instrument_id,date,price,source) VALUES (?,?,?,?) ON CONFLICT(instrument_id,date) DO UPDATE SET price=excluded.price, source=excluded.source', p.instrument_id, date, num(f.price), `Dokument #${p.document_id}`);
        }
        ref = `reconciled:${p.entity_id}:${p.instrument_id}:${date}`;
        break;
      default: {
        // Samma validering som vid manuell registrering, inklusive innehav över hela tidslinjen
        const v = validateTransaction(txBody(p, f));
        const txId = insertTransaction(v, userId, { document_id: p.document_id, details: lines ? JSON.stringify(lines) : null });
        ref = `transaction:${txId}`;
      }
    }
    run("UPDATE proposals SET status='approved', result_ref=?, decided_by=?, decided_at=datetime('now'), comment=? WHERE id=?", ref, userId, opts.comment ?? null, id);
    // Lär in hur avsändaren benämner instrument och enhet, så att nästa dokument matchas säkert
    const issuer = get<{ issuer: string | null }>('SELECT issuer FROM documents WHERE id=?', p.document_id)?.issuer ?? null;
    const learned: string[] = [];
    if (str(f.instrument_name) && learnAlias('instrument', str(f.instrument_name), issuer, p.instrument_id!, userId)) learned.push(`instrument "${str(f.instrument_name)}"`);
    if (str(f.investor_label) && p.entity_id && learnAlias('entity', str(f.investor_label), issuer, p.entity_id, userId)) learned.push(`investerare "${str(f.investor_label)}"`);
    // Spårbarhet: vad AI föreslog och vad som ändrades
    const changes = Object.fromEntries(Object.entries(f).filter(([, v]) => v.edited).map(([k, v]) => [k, { ai: v.ai_value, final: v.value }]));
    audit(userId, 'approve', 'proposal', id, {
      document_id: p.document_id, kind: p.kind, result: ref, origin: p.origin, changed_from_ai: changes,
      confirmed_low_confidence: Object.entries(f).filter(([, v]) => v.confirmed).map(([k]) => k),
      warnings_acknowledged: ev.checks.filter((c) => c.level === 'warning').map((c) => c.message),
      prepared_by: p.prepared_by, learned_aliases: learned,
    });
    refreshDocumentStatus(p.document_id);
  });
  bumpVersion();
  return ref;
}

export const dualControl = () => setting('dual_control', 'off') === 'on';

/** Fyra ögon-principen, steg 1: granskaren markerar posten som kontrollerad. */
export function prepare(id: number, userId: number | null, opts: { acknowledgeWarnings: boolean }) {
  const p = get<ProposalRow>('SELECT * FROM proposals WHERE id=?', id);
  if (!p) throw new HttpError(404, 'Förslaget finns inte');
  if (p.status !== 'pending') throw new HttpError(409, 'Förslaget är redan hanterat');
  const ev = evaluate(p, p.document_id);
  if (ev.blocking.length) throw new HttpError(400, ev.blocking.join(' · '));
  if (ev.needsAck && !opts.acknowledgeWarnings) throw new HttpError(400, 'Bekräfta att du har kontrollerat varningarna');
  run("UPDATE proposals SET prepared_by=?, prepared_at=datetime('now') WHERE id=?", userId, id);
  audit(userId, 'prepare', 'proposal', id, { document_id: p.document_id, warnings_acknowledged: ev.checks.filter((c) => c.level === 'warning').map((c) => c.message) });
}

export function reject(id: number, userId: number | null, comment: string | null) {
  const p = get<ProposalRow>('SELECT * FROM proposals WHERE id=?', id);
  if (!p) throw new HttpError(404, 'Förslaget finns inte');
  if (p.status !== 'pending') throw new HttpError(409, 'Förslaget är redan hanterat');
  run("UPDATE proposals SET status='rejected', decided_by=?, decided_at=datetime('now'), comment=? WHERE id=?", userId, comment, id);
  audit(userId, 'reject', 'proposal', id, { document_id: p.document_id, kind: p.kind, comment });
  refreshDocumentStatus(p.document_id);
}

export function refreshDocumentStatus(documentId: number) {
  const d = get<{ status: string }>('SELECT status FROM documents WHERE id=?', documentId);
  if (!d || d.status === 'processing' || d.status === 'error') return;
  const c = get<{ pending: number; total: number }>("SELECT SUM(status='pending') pending, COUNT(*) total FROM proposals WHERE document_id=?", documentId)!;
  const status = c.total > 0 && !c.pending ? 'done' : d.status === 'manual' && !c.total ? 'manual' : c.total ? 'review' : d.status;
  run('UPDATE documents SET status=? WHERE id=?', status, documentId);
}
