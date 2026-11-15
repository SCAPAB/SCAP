/**
 * Manuellt underlag: när fyra ögon-principen är på registreras manuella transaktioner, rättelser,
 * borttagningar och import som förslag i Inkorgen i stället för att bokföras direkt. Den som registrerar
 * räknas som granskare (steg 1) och en annan användare attesterar (steg 2). Rättelser och borttagningar av
 * transaktioner som bokförts från ett dokument görs på samma sätt, men på dokumentet.
 *
 * Underlaget är en textfil (sammanfattning eller den importerade CSV-filen) som sparas i databasen
 * och visas i Inkorgen bredvid posterna, så att allt är spårbart.
 */
import { createHash, randomUUID } from 'node:crypto';
import { get, run, audit } from './db.ts';
import { HttpError } from './auth.ts';
import { validateTransaction } from './validate.ts';
import { KIND_FIELDS, emptyField, refreshDocumentStatus, type Kind, type PField } from './proposals.ts';
import { TX_LABELS, txAmount, type Entity, type Instrument, type Transaction } from '../shared/types.ts';

export type UnderlagSource = 'manual' | 'import';

export function createUnderlag(source: UnderlagSource, title: string, summary: string, content: string, userId: number | null) {
  const sha = createHash('sha256').update(`${source}:${randomUUID()}`).digest('hex');
  const r = run(
    `INSERT INTO documents (filename, mime, sha256, size, status, doc_type, summary, source, content, uploaded_by, processed_at)
     VALUES (?,?,?,?, 'review', ?,?,?,?,?, datetime('now'))`,
    title.slice(0, 200), source === 'import' ? 'text/csv' : 'text/plain', sha, Buffer.byteLength(content), source === 'import' ? 'import' : 'manual_entry',
    summary, source, content, userId,
  );
  const id = Number(r.lastInsertRowid);
  audit(userId, 'create', 'document', id, { source, title });
  return id;
}

const fmtN = (n: number | null | undefined, d = 2) => (n == null || !isFinite(n) ? '' : n.toLocaleString('sv-SE', { maximumFractionDigits: d }));

/** Läsbar beskrivning av en transaktion för underlaget. */
export function describeTx(t: Partial<Transaction> & { type: Transaction['type'] }, ins: Instrument) {
  const rows: [string, string][] = [
    ['Instrument', `${ins.name}${ins.isin ? ` (${ins.isin})` : ''}`],
    ['Typ', TX_LABELS[t.type]],
    ['Affärsdag', t.trade_date ?? ''],
    ['Likviddag', t.settle_date ?? ''],
    ['Antal', t.quantity ? fmtN(t.quantity, 4) : ''],
    ['Kurs', t.price ? fmtN(t.price, 6) : ''],
    [t.type === 'CALL' ? 'Totalt anropat belopp' : 'Belopp', `${fmtN(txAmount({ type: t.type, amount: t.amount ?? 0, fee: t.fee ?? 0 }))} ${ins.currency}`],
    [t.type === 'CALL' ? 'Varav avgifter' : 'Avgift', t.fee ? fmtN(t.fee) : ''],
    ['Varav utjämningsränta', t.outside_commitment ? fmtN(t.outside_commitment) : ''],
    ['Varav återinkallningsbart', t.recallable ? fmtN(t.recallable) : ''],
    ['Valutakurs', ins.currency === 'SEK' ? '' : t.fx_rate ? fmtN(t.fx_rate, 6) : 'hämtas vid attest'],
    ['Notering', t.note ?? ''],
  ];
  return rows.filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

const manual = (id: number | null) => ({ id, method: 'manual', score: 1, confirmed: true, label: null, candidates: [] });

/** Förslagsfält från en transaktion (kapitalanrop: belopp = totalt anropat). fx_rate bara om den angetts. */
export function fieldsFromTx(t: Partial<Transaction> & { type: Transaction['type'] }, ins: Instrument, fxGiven: boolean): Record<string, PField> {
  const kind = t.type as Kind;
  const val: Record<string, string | number | null> = {
    date: t.trade_date ?? null, settle_date: t.settle_date ?? null, quantity: t.quantity || null, price: t.price || null,
    amount: txAmount({ type: t.type, amount: t.amount ?? 0, fee: t.fee ?? 0 }), fee: t.fee || null, fx_rate: fxGiven ? t.fx_rate ?? null : null,
    currency: ins.currency, note: t.note ?? null, outside_commitment: t.outside_commitment || null, recallable: t.recallable || null,
  };
  const fields: Record<string, PField> = {};
  for (const f of KIND_FIELDS[kind].map((x) => x.replace('*', ''))) fields[f] = emptyField(val[f] ?? null);
  fields.instrument_name = emptyField();
  fields.isin = emptyField();
  fields.investor_label = emptyField();
  return fields;
}

/** Lägger ett transaktionsförslag på ett underlag. prepared = registreraren räknas som granskare (fyra ögon, steg 1). */
export function addTxProposal(documentId: number, t: Partial<Transaction> & { type: Transaction['type']; entity_id: number; instrument_id: number }, opts: {
  userId: number | null; action: 'create' | 'replace' | 'remove'; replacesTx?: number | null; prepared: boolean; fxGiven: boolean;
}) {
  const ins = get<Instrument>('SELECT * FROM instruments WHERE id=?', t.instrument_id)!;
  const fields = fieldsFromTx(t, ins, opts.fxGiven);
  const seq = (get<{ n: number }>('SELECT COALESCE(MAX(seq),0) n FROM proposals WHERE document_id=?', documentId)?.n ?? 0) + 1;
  const r = run(
    `INSERT INTO proposals (document_id, seq, kind, origin, entity_id, instrument_id, match, fields, action, replaces_tx, prepared_by, prepared_at)
     VALUES (?,?,?, 'manual', ?,?,?,?,?,?,?, ${opts.prepared ? "datetime('now')" : 'NULL'})`,
    documentId, seq, t.type, t.entity_id, t.instrument_id, JSON.stringify({ entity: manual(t.entity_id), instrument: manual(t.instrument_id) }), JSON.stringify(fields),
    opts.action, opts.replacesTx ?? null, opts.prepared ? opts.userId : null,
  );
  const id = Number(r.lastInsertRowid);
  if (opts.prepared) audit(opts.userId, 'prepare', 'proposal', id, { document_id: documentId, automatic: 'registrerad av samma användare' });
  return id;
}

const ACTION_TEXT = { create: 'Ny transaktion', replace: 'Rättelse av transaktion', remove: 'Borttagning av transaktion' } as const;

/**
 * Lämnar en ändring av transaktioner till attest i Inkorgen. För en transaktion som bokförts från ett
 * dokument läggs rättelsen på samma dokument; annars skapas ett manuellt underlag.
 */
export function submitTxChange(body: Record<string, unknown>, action: 'create' | 'replace' | 'remove', user: { id: number; name: string; email: string } | undefined, opts: { replacesTx?: Transaction; prepared: boolean }) {
  const userId = user?.id ?? null;
  const cur = opts.replacesTx;
  let v: ReturnType<typeof validateTransaction> | Transaction;
  if (action === 'remove') v = cur!;
  else v = validateTransaction(body, { replaceId: cur?.id }); // ge fel direkt, innan något skickas för attest
  const ins = get<Instrument>('SELECT * FROM instruments WHERE id=?', v.instrument_id)!;
  const fxGiven = action === 'remove' || !!body.fx_rate;
  let documentId = cur?.document_id ?? null;
  if (!documentId) {
    const ent = get<Entity>('SELECT * FROM entities WHERE id=?', v.entity_id);
    const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const title = `${ACTION_TEXT[action]}${cur ? ` #${cur.id}` : ''} – ${ins.name} ${v.trade_date}`;
    const lines = [
      'Manuellt underlag i Innehav',
      `Registrerat av: ${user ? `${user.name} (${user.email})` : 'okänd'} ${when} UTC`,
      `Åtgärd: ${ACTION_TEXT[action]}${cur ? ` #${cur.id}` : ''}`,
      `Juridisk enhet: ${ent?.name ?? v.entity_id}`,
      '',
      ...(cur ? ['Före:', describeTx(cur, get<Instrument>('SELECT * FROM instruments WHERE id=?', cur.instrument_id)!), ''] : []),
      ...(action !== 'remove' ? [cur ? 'Efter:' : 'Transaktion:', describeTx({ ...v, fx_rate: fxGiven ? v.fx_rate : undefined }, ins)] : []),
      '',
      'Posten bokförs först när en annan användare har attesterat den i Inkorgen.',
    ];
    documentId = createUnderlag('manual', title, `${ACTION_TEXT[action]} registrerad manuellt av ${user?.name ?? 'okänd'}`, lines.join('\n'), userId);
  }
  const t = action === 'remove' ? cur! : { ...v, id: 0 } as unknown as Transaction;
  const proposalId = addTxProposal(documentId, t, { userId, action, replacesTx: cur?.id ?? null, prepared: opts.prepared, fxGiven });
  refreshDocumentStatus(documentId);
  audit(userId, 'submit', 'proposal', proposalId, { document_id: documentId, action, replaces_tx: cur?.id ?? null });
  return { document_id: documentId, proposal_id: proposalId };
}

/** Finns det redan en ej hanterad rättelse/borttagning av transaktionen? */
export function pendingChangeFor(txId: number) {
  return get<{ id: number; document_id: number }>("SELECT id, document_id FROM proposals WHERE replaces_tx=? AND status='pending'", txId);
}

export function assertNoPendingChange(txId: number) {
  const p = pendingChangeFor(txId);
  if (p) throw new HttpError(409, `Det finns redan en ändring av transaktionen som väntar i Inkorgen (dokument #${p.document_id}). Hantera den först.`);
}

