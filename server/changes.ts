/**
 * Ändring och borttag av transaktioner, och fyra ögon-principen för attesterade transaktioner (F9).
 *
 * En transaktion räknas som attesterad när den har skapats via Inkorgen av ett förslag som granskats av
 * en användare och attesterats av en annan (proposals: status 'approved', prepared_by satt). När fyra
 * ögon är påslaget kan en sådan transaktion inte ändras eller tas bort direkt, inte heller av en
 * administratör (409). Den som vill rätta skickar en ändringsbegäran, och ändringen genomförs först när
 * en annan användare har attesterat den. Allt loggas i audit_log med båda användarna.
 *
 * Attest och ändringsbegäran pekar på transaktionens id. Id:t återanvänds aldrig (AUTOINCREMENT, se
 * migrateTransactionIds i db.ts), så en ny transaktion ärver aldrig en borttagen transaktions attest eller
 * historik. Varje ändringsbegäran sparar dessutom sitt eget förevärde (before_value) och visar det.
 */
import { Router, type Request } from 'express';
import { all, get, run, tx, audit } from './db.ts';
import { HttpError, requireRole } from './auth.ts';
import { bumpVersion } from './data.ts';
import { dualControl } from './proposals.ts';
import { validateTransaction, checkHoldingTimeline, checkCommitmentTimeline } from './validate.ts';
import type { Transaction } from '../shared/types.ts';

export const ATTESTED_MSG = 'Transaktionen är attesterad enligt fyra ögon-principen. Skicka ändringen för attest.';

/** SQL-uttryck (för en transaktion med alias t) som är 1 om transaktionen är attesterad. */
export const ATTESTED_SQL = "EXISTS (SELECT 1 FROM proposals ap WHERE ap.status='approved' AND ap.prepared_by IS NOT NULL AND ap.result_ref = 'transaction:' || t.id)";
/** SQL-uttryck (alias t) med id för en väntande ändringsbegäran, eller NULL. */
export const PENDING_CHANGE_SQL = "(SELECT cr.id FROM change_requests cr WHERE cr.transaction_id = t.id AND cr.status = 'pending' ORDER BY cr.id LIMIT 1)";

export function isAttested(transactionId: number): boolean {
  return !!get("SELECT 1 FROM proposals WHERE status='approved' AND prepared_by IS NOT NULL AND result_ref=?", `transaction:${transactionId}`);
}

/** Stoppar direkt ändring eller borttag av en attesterad transaktion när fyra ögon är påslaget (409). */
export function assertNotLocked(transactionId: number) {
  if (dualControl() && isAttested(transactionId)) throw new HttpError(409, ATTESTED_MSG);
}

/**
 * Validerar en ändring av en befintlig transaktion. Kastar 400 om ändringen är ogiltig, också när den
 * prövas mot befintliga data (innehav och åtagande över tidslinjen, F4 och F5).
 */
export function prepareTransactionUpdate(cur: Transaction, body: Record<string, unknown>) {
  // Fälten utanför åtagandet och återinkallningsbart behålls om de inte skickas med (formuläret saknar dem)
  const v = validateTransaction({ outside_commitment: cur.outside_commitment, recallable: cur.recallable, ...body, id: cur.id });
  // Flyttas affären till ett annat instrument eller en annan enhet prövas också instrumentet där den fanns
  if (cur.entity_id !== v.entity_id || cur.instrument_id !== v.instrument_id) {
    const msg = cur.type === 'BUY' || cur.type === 'SELL' ? checkHoldingTimeline(cur.entity_id, cur.instrument_id, { remove: cur.id })
      : cur.type === 'COMMITMENT' || cur.type === 'DISTRIBUTION' ? checkCommitmentTimeline(cur.entity_id, cur.instrument_id, { remove: cur.id }) : null;
    if (msg) throw new HttpError(400, msg);
  }
  return v;
}

export function writeTransactionUpdate(id: number, v: ReturnType<typeof validateTransaction>) {
  run(
    'UPDATE transactions SET entity_id=?,instrument_id=?,type=?,trade_date=?,settle_date=?,quantity=?,price=?,amount=?,fee=?,fx_rate=?,note=?,outside_commitment=?,recallable=? WHERE id=?',
    v.entity_id, v.instrument_id, v.type, v.trade_date, v.settle_date, v.quantity, v.price, v.amount, v.fee, v.fx_rate, v.note, v.outside_commitment, v.recallable, id,
  );
}

/** Stoppar borttag av en transaktion som senare poster bygger på (409, F4 och F5). */
export function assertTransactionDeletable(cur: Transaction) {
  if (cur.type === 'BUY' || cur.type === 'SELL') {
    const msg = checkHoldingTimeline(cur.entity_id, cur.instrument_id, { remove: cur.id });
    if (msg) throw new HttpError(409, `Transaktionen kan inte tas bort: ${msg}`);
  }
  if (cur.type === 'COMMITMENT' || (cur.type === 'DISTRIBUTION' && (cur.recallable ?? 0) > 0)) {
    const msg = checkCommitmentTimeline(cur.entity_id, cur.instrument_id, { remove: cur.id });
    if (msg) throw new HttpError(409, `Transaktionen kan inte tas bort: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Ändringsbegäran
// ---------------------------------------------------------------------------

interface ChangeRequestRow {
  id: number; transaction_id: number; action: 'update' | 'delete'; payload: string | null; before_value: string | null; requested_by: number | null; requested_at: string;
  status: 'pending' | 'approved' | 'rejected'; decided_by: number | null; decided_at: string | null; comment: string | null;
}

export function createChangeRequest(transactionId: number, userId: number | null, body: { action?: unknown; payload?: unknown; comment?: unknown }) {
  const cur = get<Transaction>('SELECT * FROM transactions WHERE id=?', transactionId);
  if (!cur) throw new HttpError(404, 'Transaktionen finns inte');
  const action = String(body.action ?? '');
  if (action !== 'update' && action !== 'delete') throw new HttpError(400, 'Ange om ändringsbegäran gäller ändring eller borttag');
  if (get("SELECT 1 FROM change_requests WHERE transaction_id=? AND status='pending'", transactionId)) {
    throw new HttpError(409, 'Det finns redan en ändringsbegäran för transaktionen som väntar på attest');
  }
  let after: ReturnType<typeof validateTransaction> | null = null;
  if (action === 'update') {
    if (!body.payload || typeof body.payload !== 'object') throw new HttpError(400, 'De nya värdena saknas');
    after = prepareTransactionUpdate(cur, body.payload as Record<string, unknown>);
  } else assertTransactionDeletable(cur);
  const comment = String(body.comment ?? '').trim().slice(0, 500) || null;
  // Förevärdet sparas på begäran, så att den alltid visar transaktionen som den såg ut när begäran skapades
  const before = get(
    `SELECT t.*, i.name instrument_name, i.currency, e.name entity_name FROM transactions t
     JOIN instruments i ON i.id=t.instrument_id JOIN entities e ON e.id=t.entity_id WHERE t.id=?`, transactionId,
  ) ?? cur;
  const r = run('INSERT INTO change_requests (transaction_id, action, payload, before_value, requested_by, comment) VALUES (?,?,?,?,?,?)',
    transactionId, action, after ? JSON.stringify(after) : null, JSON.stringify(before), userId, comment);
  const id = Number(r.lastInsertRowid);
  audit(userId, 'create', 'change_request', id, { transaction_id: transactionId, action, before: cur, after, comment });
  return id;
}

export function approveChangeRequest(id: number, userId: number | null, comment?: string | null) {
  const c = get<ChangeRequestRow>('SELECT * FROM change_requests WHERE id=?', id);
  if (!c) throw new HttpError(404, 'Ändringsbegäran finns inte');
  if (c.status !== 'pending') throw new HttpError(409, 'Ändringsbegäran är redan hanterad');
  if (c.requested_by != null && c.requested_by === userId) {
    throw new HttpError(403, 'Fyra ögon-principen: en annan användare än den som begärde ändringen måste attestera');
  }
  tx(() => {
    const cur = get<Transaction>('SELECT * FROM transactions WHERE id=?', c.transaction_id);
    if (!cur) throw new HttpError(409, 'Transaktionen finns inte längre');
    let after: ReturnType<typeof validateTransaction> | null = null;
    // Ändringen valideras på nytt mot dagens data (innehav, åtagande, valutakurs)
    if (c.action === 'update') {
      after = prepareTransactionUpdate(cur, JSON.parse(c.payload ?? '{}'));
      writeTransactionUpdate(cur.id, after);
    } else {
      assertTransactionDeletable(cur);
      run('DELETE FROM transactions WHERE id=?', cur.id);
    }
    const note = String(comment ?? '').trim().slice(0, 500) || null;
    run("UPDATE change_requests SET status='approved', decided_by=?, decided_at=datetime('now'), comment=COALESCE(?, comment) WHERE id=?", userId, note, id);
    const who = { change_request: id, requested_by: c.requested_by, approved_by: userId };
    audit(userId, c.action, 'transaction', cur.id, c.action === 'update' ? { before: cur, after, ...who } : { ...cur, ...who });
    audit(userId, 'approve', 'change_request', id, { transaction_id: cur.id, action: c.action, before: cur, after, ...who, comment: note });
  });
  bumpVersion();
}

export function rejectChangeRequest(id: number, userId: number | null, comment?: string | null) {
  const c = get<ChangeRequestRow>('SELECT * FROM change_requests WHERE id=?', id);
  if (!c) throw new HttpError(404, 'Ändringsbegäran finns inte');
  if (c.status !== 'pending') throw new HttpError(409, 'Ändringsbegäran är redan hanterad');
  const note = String(comment ?? '').trim().slice(0, 500) || null;
  run("UPDATE change_requests SET status='rejected', decided_by=?, decided_at=datetime('now'), comment=COALESCE(?, comment) WHERE id=?", userId, note, id);
  audit(userId, 'reject', 'change_request', id, { transaction_id: c.transaction_id, action: c.action, requested_by: c.requested_by, rejected_by: userId, comment: note });
}

export function listChangeRequests(status: string) {
  const where = status === 'all' ? '' : 'WHERE c.status = ?';
  const rows = all<ChangeRequestRow & { requested_by_name: string | null; decided_by_name: string | null }>(
    `SELECT c.*, ru.name requested_by_name, du.name decided_by_name FROM change_requests c
     LEFT JOIN users ru ON ru.id = c.requested_by LEFT JOIN users du ON du.id = c.decided_by
     ${where} ORDER BY c.id DESC LIMIT 500`,
    ...(status === 'all' ? [] : [status]),
  );
  // Begäran visar sitt eget sparade förevärde, aldrig den aktuella raden (som kan ha ändrats eller tagits bort)
  return rows.map(({ before_value, ...c }) => ({
    ...c,
    payload: c.payload ? JSON.parse(c.payload) : null,
    transaction: before_value ? withNames(JSON.parse(before_value) as Transaction & { instrument_name?: string }) : null,
  }));
}

/** Kompletterar ett förevärde som saknar namn (begäranden från före F9-rättelsen, hämtade ur audit_log). */
function withNames(t: Transaction & { instrument_name?: string }) {
  if (t.instrument_name !== undefined) return t;
  const i = get<{ name: string; currency: string }>('SELECT name, currency FROM instruments WHERE id=?', t.instrument_id);
  const e = get<{ name: string }>('SELECT name FROM entities WHERE id=?', t.entity_id);
  return { ...t, instrument_name: i?.name ?? null, currency: i?.currency ?? null, entity_name: e?.name ?? null };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const uid = (req: Request) => req.user?.id ?? null;
const editor = requireRole('editor');

export const changeRoutes = Router();

changeRoutes.post('/transactions/:id/change-requests', editor, (req, res) => {
  const id = createChangeRequest(Number(req.params.id), uid(req), req.body ?? {});
  res.status(201).json({ id });
});

changeRoutes.get('/change-requests', (req, res) => {
  const status = String(req.query.status ?? 'pending');
  if (!['pending', 'approved', 'rejected', 'all'].includes(status)) throw new HttpError(400, 'Okänd status');
  res.json(listChangeRequests(status));
});

changeRoutes.post('/change-requests/:id/approve', editor, (req, res) => {
  approveChangeRequest(Number(req.params.id), uid(req), req.body?.comment ?? null);
  res.json({ ok: true });
});

changeRoutes.post('/change-requests/:id/reject', editor, (req, res) => {
  rejectChangeRequest(Number(req.params.id), uid(req), req.body?.comment ?? null);
  res.json({ ok: true });
});
