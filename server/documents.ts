import { Router, type Request } from 'express';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { all, get, run, audit, DB_PATH } from './db.ts';
import { HttpError, requireRole } from './auth.ts';
import { aiStatus, describeAiError, extractDocument } from './ai.ts';
import {
  KIND_FIELDS, LABELS, LINE_CATEGORIES, approve, prepare, dualControl, normalizeLines, proposeHoldingFix, buildProposals, createManualProposal, emptyField, evaluate, reject, refreshDocumentStatus,
  type Kind, type LineItem, type PField, type ProposalRow,
} from './proposals.ts';
import type { Entity, Instrument } from '../shared/types.ts';

export const docs = Router();
const editor = requireRole('editor');
const uid = (req: Request) => req.user?.id ?? null;

const STORE = process.env.INNEHAV_DOCS ?? join(dirname(DB_PATH), 'documents');
const MIMES: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
const filePath = (sha: string, mime: string) => join(STORE, `${sha}.${MIMES[mime]}`);

interface DocRow {
  id: number; filename: string; mime: string; sha256: string; size: number; status: string; doc_type: string | null; issuer: string | null;
  investor_label: string | null; summary: string | null; extraction: string | null; ai_model: string | null; error: string | null;
  uploaded_by: number | null; uploaded_at: string; processed_at: string | null;
}

export const DOC_TYPE_LABELS: Record<string, string> = {
  capital_call: 'Kapitalanrop', distribution_notice: 'Utdelningsnotis PE', capital_account_statement: 'Kapitalkontoutdrag (CAS)',
  fund_trade_confirmation: 'Avräkningsnota fond', equity_trade_confirmation: 'Avräkningsnota aktie', dividend_notice: 'Utdelningsbesked',
  holdings_statement: 'Innehavsbesked', other: 'Övrigt',
};

docs.get('/ai/status', (_req, res) => res.json(aiStatus()));

// ---------------------------------------------------------------------------
// Tolkning (körs i bakgrunden)
// ---------------------------------------------------------------------------

const running = new Set<number>();
async function processDocument(id: number, hint?: string) {
  if (running.has(id)) return;
  running.add(id);
  const d = get<DocRow>('SELECT * FROM documents WHERE id=?', id)!;
  run("UPDATE documents SET status='processing', error=NULL WHERE id=?", id);
  try {
    if (!aiStatus().enabled) {
      run("UPDATE documents SET status='manual', error=?, processed_at=datetime('now') WHERE id=?", 'AI-tolkning är inte aktiverad – registrera posterna manuellt', id);
      return;
    }
    const file = readFileSync(filePath(d.sha256, d.mime));
    const { extraction, model } = await extractDocument(file, d.mime, d.sha256, {
      filename: d.filename,
      hint,
      entities: all<Entity>('SELECT name, org_nr FROM entities').map((e) => (e.org_nr ? `${e.name} (org.nr ${e.org_nr})` : e.name)),
      instruments: all<Instrument>('SELECT name, isin, type, currency FROM instruments ORDER BY name').map((i) => `${i.name}${i.isin ? ` [${i.isin}]` : ''} (${i.currency})`),
      rules: all<{ issuer: string; instructions: string }>('SELECT issuer, instructions FROM extraction_rules ORDER BY issuer'),
    });
    buildProposals(id, extraction);
    run(
      "UPDATE documents SET status='review', doc_type=?, issuer=?, investor_label=?, summary=?, extraction=?, ai_model=?, processed_at=datetime('now') WHERE id=?",
      extraction.document_type, extraction.issuer.value, extraction.investor_label.value, extraction.summary, JSON.stringify(extraction), model, id,
    );
    refreshDocumentStatus(id);
  } catch (e) {
    console.error('Tolkning misslyckades', id, e);
    run("UPDATE documents SET status='error', error=?, processed_at=datetime('now') WHERE id=?", describeAiError(e), id);
  } finally {
    running.delete(id);
  }
}

// Dokument som var under tolkning när servern stängdes tolkas om vid start
setTimeout(() => {
  for (const d of all<{ id: number }>("SELECT id FROM documents WHERE status='processing'")) void processDocument(d.id);
}, 500);

// ---------------------------------------------------------------------------
// Dokument
// ---------------------------------------------------------------------------

docs.post('/documents', editor, (req, res) => {
  const { filename, mime, data } = req.body ?? {};
  if (!MIMES[mime]) throw new HttpError(400, 'Endast PDF, PNG och JPG kan läsas in');
  const buf = Buffer.from(String(data ?? ''), 'base64');
  if (!buf.length) throw new HttpError(400, 'Filen är tom');
  if (buf.length > 25 * 1024 * 1024) throw new HttpError(400, 'Filen är större än 25 MB');
  const sha = createHash('sha256').update(buf).digest('hex');
  const existing = get<DocRow>('SELECT id, filename FROM documents WHERE sha256=?', sha);
  if (existing) return res.status(200).json({ id: existing.id, duplicate: true, message: `Samma fil är redan uppladdad som "${existing.filename}"` });
  mkdirSync(STORE, { recursive: true });
  writeFileSync(filePath(sha, mime), buf);
  const r = run('INSERT INTO documents (filename, mime, sha256, size, uploaded_by) VALUES (?,?,?,?,?)', String(filename || 'dokument').slice(0, 200), mime, sha, buf.length, uid(req));
  const id = Number(r.lastInsertRowid);
  audit(uid(req), 'upload', 'document', id, { filename, sha256: sha });
  void processDocument(id);
  res.status(201).json({ id, duplicate: false });
});

docs.get('/documents', (req, res) => {
  const status = req.query.status as string | undefined;
  const rows = all<DocRow & { uploader: string | null; pending: number; approved: number; rejected: number; total: number }>(
    `SELECT d.id, d.filename, d.mime, d.status, d.doc_type, d.issuer, d.summary, d.error, d.uploaded_at, d.processed_at, u.name uploader,
       COALESCE(SUM(p.status='pending'),0) pending, COALESCE(SUM(p.status='pending' AND p.prepared_by IS NOT NULL),0) prepared, COALESCE(SUM(p.status='approved'),0) approved, COALESCE(SUM(p.status='rejected'),0) rejected, COUNT(p.id) total,
       (SELECT group_concat(DISTINCT i.name) FROM proposals p2 JOIN instruments i ON i.id=p2.instrument_id WHERE p2.document_id=d.id) funds
     FROM documents d LEFT JOIN users u ON u.id=d.uploaded_by LEFT JOIN proposals p ON p.document_id=d.id
     ${status ? 'WHERE d.status = ?' : ''} GROUP BY d.id ORDER BY d.id DESC LIMIT 500`,
    ...(status ? [status] : []),
  );
  res.json(rows.map((r) => ({ ...r, doc_type_label: r.doc_type ? DOC_TYPE_LABELS[r.doc_type] ?? r.doc_type : null })));
});

docs.get('/documents/counts', (_req, res) => {
  res.json(get("SELECT SUM(status IN ('review','manual')) toReview, SUM(status='processing') processing, SUM(status='error') errors FROM documents"));
});

docs.get('/documents/:id', (req, res) => {
  const d = get<DocRow & { uploader: string | null }>('SELECT d.*, u.name uploader FROM documents d LEFT JOIN users u ON u.id=d.uploaded_by WHERE d.id=?', Number(req.params.id));
  if (!d) throw new HttpError(404, 'Dokumentet finns inte');
  const extraction = d.extraction ? JSON.parse(d.extraction) : null;
  const { extraction: _x, ...doc } = d;
  const neighbours = {
    next: get<{ id: number }>("SELECT id FROM documents WHERE id < ? AND status IN ('review','manual') ORDER BY id DESC LIMIT 1", d.id)?.id ?? get<{ id: number }>("SELECT id FROM documents WHERE id > ? AND status IN ('review','manual') ORDER BY id DESC LIMIT 1", d.id)?.id ?? null,
  };
  res.json({
    document: { ...doc, doc_type_label: d.doc_type ? DOC_TYPE_LABELS[d.doc_type] : null, warnings: extraction?.warnings ?? [] },
    proposals: proposalsFor(d.id),
    ...neighbours,
  });
});

function proposalsFor(documentId: number) {
  return all<ProposalRow>('SELECT * FROM proposals WHERE document_id=? ORDER BY seq', documentId).map(presentProposal);
}

function presentProposal(p: ProposalRow) {
  const ev = evaluate(p, p.document_id);
  const decider = p.decided_by ? get<{ name: string }>('SELECT name FROM users WHERE id=?', p.decided_by)?.name : null;
  return {
    ...p,
    fields: JSON.parse(p.fields) as Record<string, PField>,
    line_items: normalizeLines(p.kind, p.line_items ? JSON.parse(p.line_items) : null),
    line_categories: (LINE_CATEGORIES as Record<string, string[]>)[p.kind] ?? null,
    prepared_by_name: p.prepared_by ? get<{ name: string }>('SELECT name FROM users WHERE id=?', p.prepared_by)?.name ?? null : null,
    match: p.match ? JSON.parse(p.match) : null,
    field_order: KIND_FIELDS[p.kind].map((f) => ({ key: f.replace('*', ''), required: f.endsWith('*'), label: LABELS[f.replace('*', '')] })),
    decided_by_name: decider,
    ...ev,
  };
}

docs.get('/documents/:id/file', (req, res) => {
  const d = get<DocRow>('SELECT * FROM documents WHERE id=?', Number(req.params.id));
  if (!d) throw new HttpError(404, 'Dokumentet finns inte');
  const f = filePath(d.sha256, d.mime);
  if (!existsSync(f)) throw new HttpError(404, 'Filen saknas');
  res.setHeader('Content-Type', d.mime);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(d.filename)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(readFileSync(f));
});

docs.post('/documents/:id/reprocess', editor, (req, res) => {
  const id = Number(req.params.id);
  const d = get<DocRow>('SELECT * FROM documents WHERE id=?', id);
  if (!d) throw new HttpError(404, 'Dokumentet finns inte');
  const hint = String(req.body?.hint ?? '').trim().slice(0, 2000) || undefined;
  audit(uid(req), 'reprocess', 'document', id, { hint });
  void processDocument(id, hint);
  res.json({ ok: true });
});

docs.delete('/documents/:id', editor, (req, res) => {
  const id = Number(req.params.id);
  if (get("SELECT 1 FROM proposals WHERE document_id=? AND status='approved'", id)) throw new HttpError(409, 'Dokumentet har godkända poster och kan inte tas bort');
  run('DELETE FROM proposals WHERE document_id=?', id);
  run('DELETE FROM documents WHERE id=?', id);
  audit(uid(req), 'delete', 'document', id);
  res.json({ ok: true });
});

docs.post('/documents/:id/proposals', editor, (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 FROM documents WHERE id=?', id)) throw new HttpError(404, 'Dokumentet finns inte');
  const kind = String(req.body?.kind) as Kind;
  if (!KIND_FIELDS[kind]) throw new HttpError(400, 'Okänd posttyp');
  const pid = createManualProposal(id, kind);
  refreshDocumentStatus(id);
  res.status(201).json({ id: pid });
});

// ---------------------------------------------------------------------------
// Förslag
// ---------------------------------------------------------------------------

docs.put('/proposals/:id', editor, (req, res) => {
  const id = Number(req.params.id);
  const p = get<ProposalRow>('SELECT * FROM proposals WHERE id=?', id);
  if (!p) throw new HttpError(404, 'Förslaget finns inte');
  if (p.status !== 'pending') throw new HttpError(409, 'Förslaget är redan hanterat');
  const b = req.body ?? {};
  let fields = JSON.parse(p.fields) as Record<string, PField>;
  let kind = p.kind;
  if (b.kind && b.kind !== p.kind) {
    if (!KIND_FIELDS[b.kind as Kind]) throw new HttpError(400, 'Okänd posttyp');
    kind = b.kind;
    const next: Record<string, PField> = { instrument_name: fields.instrument_name, isin: fields.isin, investor_label: fields.investor_label ?? emptyField() };
    for (const f of KIND_FIELDS[kind].map((x) => x.replace('*', ''))) next[f] = fields[f] ?? emptyField();
    fields = next;
  }
  if (b.fields && typeof b.fields === 'object') {
    for (const [k, v] of Object.entries(b.fields as Record<string, unknown>)) {
      if (!fields[k]) continue;
      const val = v === '' || v == null ? null : (v as string | number);
      if (String(val ?? '') === String(fields[k].value ?? '')) continue;
      fields[k] = { ...fields[k], value: val, edited: String(val ?? '') !== String(fields[k].ai_value ?? '') || fields[k].ai_value == null && val != null };
      if (!fields[k].edited) fields[k].confirmed = false;
    }
  }
  if (Array.isArray(b.confirm)) for (const k of b.confirm as string[]) if (fields[k]) fields[k].confirmed = true;
  if (Array.isArray(b.unconfirm)) for (const k of b.unconfirm as string[]) if (fields[k]) fields[k].confirmed = false;
  const lines = Array.isArray(b.line_items) ? normalizeLines(kind, b.line_items as LineItem[]) : normalizeLines(kind, p.line_items ? JSON.parse(p.line_items) : null);
  const entity = b.entity_id !== undefined ? (b.entity_id ? Number(b.entity_id) : null) : p.entity_id;
  const instrument = b.instrument_id !== undefined ? (b.instrument_id ? Number(b.instrument_id) : null) : p.instrument_id;
  // Manuellt val eller bekräftelse gör matchningen säker
  const match = (p.match ? JSON.parse(p.match) : {}) as Record<string, Record<string, unknown>>;
  const setManual = (k: 'entity' | 'instrument', id: number | null) => { match[k] = { ...(match[k] ?? { label: null, candidates: [] }), id, method: 'manual', score: 1, confirmed: true }; };
  if (b.entity_id !== undefined && entity !== p.entity_id) setManual('entity', entity);
  if (b.instrument_id !== undefined && instrument !== p.instrument_id) setManual('instrument', instrument);
  if (Array.isArray(b.confirm_match)) for (const k of b.confirm_match as string[]) if (match[k]) match[k].confirmed = true;
  run('UPDATE proposals SET kind=?, fields=?, line_items=?, entity_id=?, instrument_id=?, match=?, prepared_by=NULL, prepared_at=NULL WHERE id=?',
    kind, JSON.stringify(fields), lines ? JSON.stringify(lines) : null, entity, instrument, JSON.stringify(match), id);
  res.json(presentProposal(get<ProposalRow>('SELECT * FROM proposals WHERE id=?', id)!));
});

docs.post('/proposals/:id/prepare', editor, (req, res) => {
  prepare(Number(req.params.id), uid(req), { acknowledgeWarnings: !!req.body?.acknowledgeWarnings });
  res.json({ ok: true });
});

docs.get('/settings', (_req, res) => res.json({ dual_control: dualControl(), report_lag_days: Number(get<{ value: string }>("SELECT value FROM settings WHERE key='report_lag_days'")?.value ?? 90) }));
docs.put('/settings', requireRole('admin'), (req, res) => {
  if (req.body?.dual_control !== undefined) run("INSERT INTO settings (key,value) VALUES ('dual_control',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", req.body.dual_control ? 'on' : 'off');
  if (req.body?.report_lag_days !== undefined) run("INSERT INTO settings (key,value) VALUES ('report_lag_days',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(Math.max(15, Math.min(180, Number(req.body.report_lag_days) || 90))));
  audit(uid(req), 'update', 'settings', null, req.body);
  res.json({ ok: true });
});

docs.get('/aliases', (_req, res) => {
  res.json(all(`SELECT a.*, u.name created_by_name, CASE a.kind WHEN 'instrument' THEN (SELECT name FROM instruments WHERE id=a.target_id) ELSE (SELECT name FROM entities WHERE id=a.target_id) END target_name
    FROM aliases a LEFT JOIN users u ON u.id=a.created_by ORDER BY a.kind, a.raw`));
});
docs.delete('/aliases/:id', editor, (req, res) => {
  run('DELETE FROM aliases WHERE id=?', Number(req.params.id));
  audit(uid(req), 'delete', 'alias', req.params.id);
  res.json({ ok: true });
});

docs.post('/proposals/:id/approve', editor, (req, res) => {
  const ref = approve(Number(req.params.id), uid(req), { acknowledgeWarnings: !!req.body?.acknowledgeWarnings, comment: req.body?.comment ?? null });
  res.json({ ok: true, ref });
});

docs.post('/proposals/:id/fix-holding', editor, (req, res) => {
  const id = proposeHoldingFix(Number(req.params.id));
  refreshDocumentStatus(get<ProposalRow>('SELECT * FROM proposals WHERE id=?', id)!.document_id);
  res.status(201).json({ id });
});

docs.post('/proposals/:id/reject', editor, (req, res) => {
  reject(Number(req.params.id), uid(req), String(req.body?.comment ?? '').trim() || null);
  res.json({ ok: true });
});

docs.delete('/proposals/:id', editor, (req, res) => {
  const p = get<ProposalRow>('SELECT * FROM proposals WHERE id=?', Number(req.params.id));
  if (!p) throw new HttpError(404, 'Förslaget finns inte');
  if (p.status !== 'pending' || p.origin !== 'manual') throw new HttpError(409, 'Endast egna, ej hanterade poster kan tas bort – avvisa AI-förslag i stället');
  run('DELETE FROM proposals WHERE id=?', p.id);
  refreshDocumentStatus(p.document_id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Tolkningsregler per avsändare
// ---------------------------------------------------------------------------

docs.get('/extraction-rules', (_req, res) => {
  res.json(all('SELECT r.*, u.name updated_by_name FROM extraction_rules r LEFT JOIN users u ON u.id=r.updated_by ORDER BY issuer'));
});
docs.post('/extraction-rules', editor, (req, res) => {
  const issuer = String(req.body?.issuer ?? '').trim();
  const instructions = String(req.body?.instructions ?? '').trim();
  if (!issuer || !instructions) throw new HttpError(400, 'Avsändare och instruktion krävs');
  const r = run('INSERT INTO extraction_rules (issuer, instructions, updated_by) VALUES (?,?,?)', issuer, instructions.slice(0, 4000), uid(req));
  audit(uid(req), 'create', 'extraction_rule', r.lastInsertRowid, { issuer, instructions });
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
docs.put('/extraction-rules/:id', editor, (req, res) => {
  const issuer = String(req.body?.issuer ?? '').trim();
  const instructions = String(req.body?.instructions ?? '').trim();
  if (!issuer || !instructions) throw new HttpError(400, 'Avsändare och instruktion krävs');
  run("UPDATE extraction_rules SET issuer=?, instructions=?, updated_by=?, updated_at=datetime('now') WHERE id=?", issuer, instructions.slice(0, 4000), uid(req), Number(req.params.id));
  audit(uid(req), 'update', 'extraction_rule', req.params.id, { issuer, instructions });
  res.json({ ok: true });
});
docs.delete('/extraction-rules/:id', editor, (req, res) => {
  run('DELETE FROM extraction_rules WHERE id=?', Number(req.params.id));
  audit(uid(req), 'delete', 'extraction_rule', req.params.id);
  res.json({ ok: true });
});
