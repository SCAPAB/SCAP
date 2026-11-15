import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useApp, useFetch } from '../context';
import { ErrorBox, Loading, Modal } from '../components/ui';
import DocViewer, { type Highlight } from '../components/DocViewer';
import InstrumentForm from '../components/InstrumentForm';
import { fmt } from '../format';
import { STATUS, type DocListRow } from './Inbox';
import type { Instrument, InstrumentType } from '../../../shared/types';

type Confidence = 'high' | 'medium' | 'low';
interface PField { value: string | number | null; ai_value: string | number | null; confidence: Confidence | null; page: number | null; quote: string | null; edited: boolean; confirmed: boolean }
interface LineItem { description: string; amount: number; affects_nav: boolean; page: number | null }
interface Check { level: 'error' | 'warning' | 'ok' | 'info'; code: string; message: string }
export type Kind = 'BUY' | 'SELL' | 'DIVIDEND' | 'FEE' | 'COMMITMENT' | 'CALL' | 'DISTRIBUTION' | 'NAV' | 'PRICE' | 'HOLDING';
interface Proposal {
  id: number; document_id: number; seq: number; kind: Kind; origin: 'ai' | 'manual'; status: 'pending' | 'approved' | 'rejected';
  entity_id: number | null; instrument_id: number | null; fields: Record<string, PField>; line_items: LineItem[] | null;
  match: { entity: { method: string; score: number; label: string | null }; instrument: { method: string; score: number; label: string | null } } | null;
  field_order: { key: string; required: boolean; label: string }[];
  result_ref: string | null; decided_by_name: string | null; decided_at: string | null; comment: string | null;
  checks: Check[]; preview: { label: string; before: string; after: string }[]; canApprove: boolean; blocking: string[]; needsAck: boolean;
}
interface DocResp {
  document: Omit<DocListRow, 'pending' | 'approved' | 'rejected' | 'total'> & { investor_label: string | null; ai_model: string | null; processed_at: string | null; warnings: string[]; uploader: string | null };
  proposals: Proposal[];
  next: number | null;
}

export const KIND_LABELS: Record<Kind, string> = {
  CALL: 'Kapitalanrop', DISTRIBUTION: 'Utdelning från PE-fond', NAV: 'NAV / kapitalkonto', COMMITMENT: 'Åtagande',
  BUY: 'Köp', SELL: 'Sälj', DIVIDEND: 'Aktieutdelning', FEE: 'Avgift', PRICE: 'Kurs', HOLDING: 'Innehav (avstämning)',
};
const KIND_TYPES: Record<Kind, InstrumentType[]> = {
  CALL: ['PE_FUND'], DISTRIBUTION: ['PE_FUND'], COMMITMENT: ['PE_FUND'], NAV: ['PE_FUND'],
  BUY: ['EQUITY', 'FUND'], SELL: ['EQUITY', 'FUND'], DIVIDEND: ['EQUITY', 'FUND'], PRICE: ['EQUITY', 'FUND'], HOLDING: ['EQUITY', 'FUND'],
  FEE: ['EQUITY', 'FUND', 'PE_FUND'],
};
const NUMERIC = new Set(['amount', 'fee', 'quantity', 'price', 'fx_rate', 'commitment_total', 'paid_in_total', 'unfunded', 'distributed_total']);
const DATES = new Set(['date', 'settle_date']);
const MATCH_TEXT: Record<string, string> = {
  isin: 'matchad på ISIN', name: 'matchad på namn', org_nr: 'matchad på org.nr', label: 'matchad på namn',
  single_holder: 'enda enheten med innehav', only_entity: 'enda enheten', none: 'ingen träff – välj',
};

/** Tolkar svenska och engelska talformat: "1 234 567,89", "1,234,567.89", "12500". */
export function parseNum(s: string): number | null {
  const t = s.replace(/[\s  ]/g, '').replace(/[−–]/g, '-').replace(/[^\d,.\-]/g, '');
  if (!t) return null;
  let n: string;
  if (t.includes(',') && t.includes('.')) n = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (t.includes(',')) n = /^-?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  else n = /^-?\d{1,3}(\.\d{3}){2,}$/.test(t) ? t.replace(/\./g, '') : t;
  const v = Number(n);
  return isFinite(v) ? v : null;
}
const show = (k: string, v: PField['value']) => (v == null ? '' : NUMERIC.has(k) && typeof v === 'number' ? v.toLocaleString('sv-SE', { maximumFractionDigits: 6 }) : String(v));

export default function Review() {
  const { id } = useParams();
  const nav = useNavigate();
  const { canEdit, entities, bump } = useApp();
  const [tick, setTick] = useState(0);
  const { data, error, setData } = useFetch<DocResp>(`/documents/${id}`, [tick]);
  const { data: instruments } = useFetch<Instrument[]>('/instruments');
  const [active, setActive] = useState<number | null>(null);
  const [hl, setHl] = useState<Highlight | null>(null);
  const [reprocess, setReprocess] = useState(false);
  const [rule, setRule] = useState(false);
  const [addKind, setAddKind] = useState<Kind | ''>('');

  const doc = data?.document;
  useEffect(() => {
    if (doc?.status !== 'processing') return;
    const t = setInterval(() => setTick((x) => x + 1), 2000);
    return () => clearInterval(t);
  }, [doc?.status]);

  // Öppna första ej hanterade post
  useEffect(() => {
    if (!data) return;
    if (active == null || !data.proposals.some((p) => p.id === active)) setActive(data.proposals.find((p) => p.status === 'pending')?.id ?? null);
  }, [data, active]);

  const replace = useCallback((p: Proposal) => setData((d) => (d ? { ...d, proposals: d.proposals.map((x) => (x.id === p.id ? p : x)) } : d)), [setData]);
  const reload = () => setTick((x) => x + 1);

  if (error) return <ErrorBox error={error} />;
  if (!data || !doc) return <Loading />;
  const handled = data.proposals.filter((p) => p.status !== 'pending').length;
  const allDone = data.proposals.length > 0 && handled === data.proposals.length;

  const addManual = async () => {
    if (!addKind) return;
    const r = await api.post<{ id: number }>(`/documents/${doc.id}/proposals`, { kind: addKind });
    setAddKind('');
    setActive(r.id);
    reload();
  };
  const remove = async () => {
    if (!confirm('Ta bort dokumentet och dess ej godkända förslag?')) return;
    try {
      await api.del(`/documents/${doc.id}`);
      bump();
      nav('/inkorg');
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div className="small"><Link to="/inkorg">← Inkorg</Link></div>
          <h1 style={{ overflowWrap: 'anywhere' }}>{doc.filename}</h1>
          <p className="row" style={{ gap: 6 }}>
            <span className={'badge ' + STATUS[doc.status].cls}>{STATUS[doc.status].label}</span>
            {doc.doc_type_label && <span className="badge">{doc.doc_type_label}</span>}
            {doc.issuer && <span>{doc.issuer}</span>}
            <span className="muted small">· uppladdad {doc.uploaded_at.slice(0, 16)} av {doc.uploader ?? '–'}{doc.ai_model ? ` · tolkad av ${doc.ai_model === 'demo' ? 'demoläge' : 'AI'}` : ''}</span>
          </p>
        </div>
        {canEdit && (
          <div className="row">
            {doc.issuer && <button className="btn" onClick={() => setRule(true)}>Regel för {doc.issuer}</button>}
            <button className="btn" onClick={() => setReprocess(true)} disabled={doc.status === 'processing'}>Tolka om</button>
            <button className="btn danger" onClick={remove}>Ta bort</button>
            {data.next && <Link className="btn primary" to={`/inkorg/${data.next}`}>Nästa dokument →</Link>}
          </div>
        )}
      </div>

      <div className="review">
        <div className="review-doc">
          <DocViewer url={`/api/documents/${doc.id}/file`} mime={doc.mime} highlight={hl} />
        </div>
        <div className="review-side">
          {doc.status === 'processing' && <div className="card"><div className="row"><span className="spinner" /> AI läser dokumentet och tar fram förslag …</div></div>}
          {doc.status === 'error' && <div className="alert error">Tolkningen misslyckades: {doc.error}. Försök igen med <em>Tolka om</em>, eller lägg till posterna manuellt nedan.</div>}
          {doc.status === 'manual' && <div className="alert">{doc.error ?? 'Registrera posterna manuellt.'} Lägg till de poster dokumentet innehåller nedan.</div>}
          {doc.summary && (
            <div className="card doc-summary">
              <div className="row"><span className="ai-tag">AI</span><span>{doc.summary}</span></div>
              {doc.investor_label && <div className="small muted" style={{ marginTop: 6 }}>Investerare enligt dokumentet: <strong>{doc.investor_label}</strong></div>}
              {doc.warnings.length > 0 && (
                <ul className="ai-warnings">{doc.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              )}
            </div>
          )}

          {data.proposals.length > 0 && (
            <div className="progress-line">
              <div className="small"><strong>{handled} av {data.proposals.length}</strong> poster hanterade</div>
              <div className="progress"><span style={{ width: `${(handled / data.proposals.length) * 100}%` }} /></div>
            </div>
          )}

          {data.proposals.map((p) => (
            p.id === active && p.status === 'pending' && canEdit
              ? <ProposalEditor key={p.id} p={p} instruments={instruments ?? []} entities={entities} onChange={replace} onHighlight={setHl}
                  onDone={() => { setHl(null); setActive(null); reload(); bump(); }} />
              : <ProposalSummary key={p.id} p={p} instruments={instruments ?? []} entities={entities} onOpen={() => setActive(p.id)} />
          ))}

          {allDone && (
            <div className="card done-card">
              <strong>✓ Dokumentet är färdighanterat.</strong>
              <div className="row mt">
                {data.next ? <Link className="btn primary" to={`/inkorg/${data.next}`}>Nästa dokument att granska →</Link> : <Link className="btn" to="/inkorg">Tillbaka till inkorgen</Link>}
              </div>
            </div>
          )}

          {canEdit && doc.status !== 'processing' && (
            <div className="row add-manual">
              <select value={addKind} onChange={(e) => setAddKind(e.target.value as Kind)} aria-label="Typ av post">
                <option value="">Lägg till post manuellt …</option>
                {(Object.keys(KIND_LABELS) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </select>
              <button className="btn" disabled={!addKind} onClick={addManual}>Lägg till</button>
            </div>
          )}
        </div>
      </div>
      {reprocess && <ReprocessModal docId={doc.id} onClose={() => setReprocess(false)} onDone={reload} />}
      {rule && doc.issuer && <RuleModal issuer={doc.issuer} onClose={() => setRule(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProposalSummary({ p, instruments, entities, onOpen }: { p: Proposal; instruments: Instrument[]; entities: { id: number; name: string }[]; onOpen: () => void }) {
  const ins = instruments.find((i) => i.id === p.instrument_id);
  const ent = entities.find((e) => e.id === p.entity_id);
  const amount = p.fields.amount?.value ?? p.fields.quantity?.value ?? p.fields.price?.value;
  const [kindRef, refId] = (p.result_ref ?? '').split(':');
  return (
    <button className={'prop-summary ' + p.status} onClick={onOpen} disabled={p.status !== 'pending'}>
      <span className="prop-status" aria-hidden>{p.status === 'approved' ? '✓' : p.status === 'rejected' ? '✕' : p.seq}</span>
      <span className="prop-main">
        <strong>{KIND_LABELS[p.kind]}</strong>
        <span>{ins?.name ?? p.fields.instrument_name?.value ?? 'Instrument saknas'} · {ent?.name ?? 'Enhet saknas'}</span>
        <span className="sub">
          {p.fields.date?.value ?? ''}{amount != null ? ` · ${typeof amount === 'number' ? fmt.num(amount) : amount}` : ''}
          {p.status === 'approved' && <> · Godkänd av {p.decided_by_name} {p.decided_at?.slice(0, 16)}{kindRef === 'transaction' && <> · <Link to="/transaktioner" onClick={(e) => e.stopPropagation()}>Transaktion #{refId}</Link></>}{kindRef === 'reconciled' && ' · avstämd'}</>}
          {p.status === 'rejected' && <> · Avvisad av {p.decided_by_name}{p.comment ? `: ${p.comment}` : ''}</>}
          {p.status === 'pending' && (p.blocking.length ? ` · ${p.blocking.length} att åtgärda` : ' · redo att godkänna')}
        </span>
      </span>
    </button>
  );
}

function ProposalEditor({ p, instruments, entities, onChange, onHighlight, onDone }: {
  p: Proposal; instruments: Instrument[]; entities: { id: number; name: string }[];
  onChange: (p: Proposal) => void; onHighlight: (h: Highlight | null) => void; onDone: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newIns, setNewIns] = useState(false);

  const save = useCallback(async (body: Record<string, unknown>) => {
    setErr(null);
    try {
      onChange(await api.put<Proposal>(`/proposals/${p.id}`, body));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [p.id, onChange]);

  const commit = (k: string) => {
    if (!(k in drafts)) return;
    const raw = drafts[k];
    const value = NUMERIC.has(k) ? (raw.trim() === '' ? null : parseNum(raw)) : raw.trim() || null;
    if (NUMERIC.has(k) && raw.trim() !== '' && value == null) { setErr(`Kunde inte tolka "${raw}" som ett tal`); return; }
    setDrafts((d) => { const { [k]: _omit, ...rest } = d; return rest; });
    if (String(value ?? '') !== String(p.fields[k]?.value ?? '')) void save({ fields: { [k]: value } });
  };

  const highlight = (k: string) => {
    const f = p.fields[k];
    setFocus(k);
    onHighlight(f && (f.page || f.quote || f.value != null) ? { page: f.page, value: f.value, quote: f.quote } : null);
  };

  const approve = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/proposals/${p.id}/approve`, { acknowledgeWarnings: ack, comment: comment || null });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rejectIt = async () => {
    const reason = prompt('Varför avvisas posten? (sparas i ändringsloggen)');
    if (reason === null) return;
    await api.post(`/proposals/${p.id}/reject`, { comment: reason });
    onDone();
  };
  const removeManual = async () => {
    await api.del(`/proposals/${p.id}`);
    onDone();
  };

  // Ctrl/Cmd + Enter godkänner
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && p.canApprove && (!p.needsAck || ack)) void approve();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const allowed = instruments.filter((i) => KIND_TYPES[p.kind].includes(i.type));
  const ins = instruments.find((i) => i.id === p.instrument_id);
  const errors = p.checks.filter((c) => c.level === 'error');
  const warnings = p.checks.filter((c) => c.level === 'warning');
  const oks = p.checks.filter((c) => c.level === 'ok' || c.level === 'info');
  const lines = p.line_items;
  const lineSum = useMemo(() => (lines ?? []).reduce((a, l) => a + l.amount, 0), [lines]);
  const docName = p.fields.instrument_name?.value;
  const docInvestor = p.fields.investor_label?.value;

  return (
    <div className="card prop-editor">
      <div className="prop-head">
        <span className="prop-status" aria-hidden>{p.seq}</span>
        <select className="kind-select" value={p.kind} onChange={(e) => save({ kind: e.target.value })} aria-label="Typ av post">
          {(Object.keys(KIND_LABELS) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
        </select>
        <span className="spacer" />
        {p.origin === 'ai' ? <span className="ai-tag" title="Förslaget kommer från AI-tolkningen">AI-förslag</span> : <span className="badge">Manuell</span>}
      </div>

      <div className="form-grid">
        <label className="field">Juridisk enhet
          <select value={p.entity_id ?? ''} onChange={(e) => save({ entity_id: e.target.value || null })} className={!p.entity_id ? 'invalid' : ''}>
            <option value="">Välj …</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <span className="hint">
            {docInvestor ? <>I dokumentet: <button type="button" className="linkish" onClick={() => highlight('investor_label')}>{String(docInvestor)}</button></> : 'Investerare ej angiven i dokumentet'}
            {p.match && p.origin === 'ai' && <> · {MATCH_TEXT[p.match.entity.method] ?? ''}</>}
          </span>
        </label>
        <label className="field">Instrument
          <span className="row" style={{ flexWrap: 'nowrap' }}>
            <select value={p.instrument_id ?? ''} onChange={(e) => save({ instrument_id: e.target.value || null })} className={!p.instrument_id ? 'invalid' : ''} style={{ flex: 1, minWidth: 0 }}>
              <option value="">Välj …</option>
              {allowed.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.currency})</option>)}
            </select>
            <button type="button" className="btn small" onClick={() => setNewIns(true)} title="Skapa nytt instrument från dokumentet">Nytt</button>
          </span>
          <span className="hint">
            {docName ? <>I dokumentet: <button type="button" className="linkish" onClick={() => highlight('instrument_name')}>{String(docName)}</button></> : '—'}
            {p.match && p.origin === 'ai' && <> · {MATCH_TEXT[p.match.instrument.method] ?? ''}</>}
          </span>
        </label>
      </div>

      <div className="fields">
        {p.field_order.map(({ key: k, required, label }) => {
          const f = p.fields[k];
          if (!f) return null;
          if (k === 'fx_rate' && (!ins || ins.currency === 'SEK')) return null;
          const val = k in drafts ? drafts[k] : show(k, f.value);
          const unit = NUMERIC.has(k) && k !== 'quantity' && k !== 'fx_rate' && ins ? ins.currency : k === 'fx_rate' && ins ? `SEK/${ins.currency}` : '';
          return (
            <div key={k} className={'pfield' + (focus === k ? ' focus' : '') + (f.confidence === 'low' && !f.edited && !f.confirmed && f.value != null ? ' needs' : '')}>
              <div className="pfield-label">
                <span>{label}{required && <span className="req" title="Obligatoriskt"> *</span>}{unit && <span className="muted"> ({unit})</span>}</span>
                <Provenance f={f} onConfirm={() => save({ confirm: [k] })} onReset={() => save({ fields: { [k]: f.ai_value } })} />
              </div>
              <input
                type={DATES.has(k) ? 'date' : 'text'}
                inputMode={NUMERIC.has(k) ? 'decimal' : undefined}
                value={val}
                placeholder={k === 'fx_rate' ? 'Hämtas automatiskt' : k === 'amount' && (p.kind === 'BUY' || p.kind === 'SELL') ? 'Antal × kurs' : ''}
                onFocus={() => highlight(k)}
                onChange={(e) => setDrafts((d) => ({ ...d, [k]: e.target.value }))}
                onBlur={() => commit(k)}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                className={NUMERIC.has(k) ? 'num' : ''}
                aria-label={label}
              />
              {focus === k && f.quote && <div className="quote">Källa{f.page ? ` s. ${f.page}` : ''}: <q>{f.quote}</q></div>}
            </div>
          );
        })}
      </div>

      {lines && lines.length > 0 && (
        <div className="lines">
          <h3>Delposter</h3>
          <table>
            <thead><tr><th>Beskrivning</th><th className="num">Belopp</th><th title="Påverkar fondandelens värde (NAV)">Påverkar NAV</th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} onMouseEnter={() => onHighlight({ page: l.page, value: l.amount, quote: l.description })}>
                  <td className="wrap">{l.description}</td>
                  <td className="num">{fmt.dec(l.amount)}</td>
                  <td>
                    <label className="row small" style={{ gap: 4 }}>
                      <input type="checkbox" checked={l.affects_nav} onChange={(e) => save({ line_items: lines.map((x, j) => (j === i ? { ...x, affects_nav: e.target.checked } : x)) })} />
                      {l.affects_nav ? 'Ja' : 'Nej – avgift'}
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td>Summa</td><td className="num">{fmt.dec(lineSum)}</td><td /></tr></tfoot>
          </table>
        </div>
      )}

      {p.preview.length > 0 && (
        <div className="effect">
          <h3>Effekt vid godkännande</h3>
          <table>
            <tbody>
              {p.preview.map((r) => (
                <tr key={r.label}><td>{r.label}</td><td className="num muted">{r.before}</td><td className="arrow">→</td><td className="num"><strong>{r.after}</strong></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="checks">
        <h3>Kontroller</h3>
        {[...errors, ...warnings, ...oks].map((c) => (
          <div key={c.code + c.message} className={'check ' + c.level}>
            <span className="ci" aria-hidden>{{ error: '✕', warning: '!', ok: '✓', info: 'i' }[c.level]}</span>
            <span>{c.message}</span>
            {c.code === 'reconcile' && c.level === 'warning' && (
              <button type="button" className="btn small" style={{ marginLeft: 'auto' }} onClick={async () => { try { await api.post(`/proposals/${p.id}/fix-holding`); onDone(); } catch (e) { setErr((e as Error).message); } }}>
                Skapa post för differensen
              </button>
            )}
          </div>
        ))}
      </div>

      {err && <div className="alert error" style={{ marginTop: 10 }}>{err}</div>}

      <div className="approve-bar">
        {p.needsAck && (
          <label className="row small ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            Jag har kontrollerat {warnings.length === 1 ? 'varningen' : `de ${warnings.length} varningarna`}
          </label>
        )}
        <input placeholder="Kommentar (valfri, sparas i loggen)" value={comment} onChange={(e) => setComment(e.target.value)} className="comment" />
        <div className="row">
          {p.origin === 'manual' ? <button className="btn danger" onClick={removeManual}>Ta bort</button> : <button className="btn danger" onClick={rejectIt}>Avvisa</button>}
          <span className="spacer" />
          <span className="small muted">{!p.canApprove ? `${p.blocking.length} kvar att åtgärda` : p.needsAck && !ack ? 'Bekräfta varningarna' : 'Ctrl+Enter'}</span>
          <button className="btn primary" disabled={!p.canApprove || (p.needsAck && !ack) || busy} onClick={approve}>{busy ? 'Sparar …' : 'Godkänn och spara'}</button>
        </div>
      </div>
      {newIns && (
        <InstrumentForm
          defaultType={KIND_TYPES[p.kind][0] === 'PE_FUND' ? 'PE_FUND' : 'FUND'}
          prefill={{ name: String(docName ?? ''), isin: String(p.fields.isin?.value ?? ''), currency: String(p.fields.currency?.value ?? 'SEK') }}
          onSaved={(newId) => void save({ instrument_id: newId })}
          onClose={() => setNewIns(false)}
        />
      )}
    </div>
  );
}

function Provenance({ f, onConfirm, onReset }: { f: PField; onConfirm: () => void; onReset: () => void }) {
  if (f.edited) {
    return (
      <span className="prov edited" title={f.ai_value != null ? `AI föreslog: ${f.ai_value}` : 'Inmatat manuellt'}>
        {f.ai_value != null ? <>Ändrad av dig · <button type="button" className="linkish" onClick={onReset}>återställ</button></> : 'Manuell'}
      </span>
    );
  }
  if (f.ai_value == null) return f.value == null ? <span className="prov none">Ej i dokumentet</span> : <span className="prov edited">Manuell</span>;
  if (f.confidence === 'low' && !f.confirmed) {
    return <span className="prov low">AI · osäker <button type="button" className="btn small confirm" onClick={onConfirm}>Bekräfta</button></span>;
  }
  if (f.confidence == null) return <span className="prov high" title="Kommentar från AI-tolkningen">AI</span>;
  if (f.confirmed) return <span className="prov ok" title="Osäkert AI-värde bekräftat av dig">AI · bekräftad av dig</span>;
  return <span className={'prov ' + (f.confidence === 'medium' ? 'medium' : 'high')} title={f.confidence === 'medium' ? 'Härlett eller beräknat – kontrollera' : 'Står uttryckligen i dokumentet'}>AI · {f.confidence === 'medium' ? 'kontrollera' : 'säker'}</span>;
}

function ReprocessModal({ docId, onClose, onDone }: { docId: number; onClose: () => void; onDone: () => void }) {
  const [hint, setHint] = useState('');
  const go = async () => {
    await api.post(`/documents/${docId}/reprocess`, { hint });
    onDone();
    onClose();
  };
  return (
    <Modal title="Tolka om dokumentet" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Avbryt</button><button className="btn primary" onClick={go}>Tolka om</button></>}>
      <p className="small">Ej hanterade AI-förslag ersätts. Redan godkända poster påverkas inte.</p>
      <label className="field">Instruktion till AI (valfri)
        <textarea rows={4} value={hint} onChange={(e) => setHint(e.target.value)} placeholder="T.ex. ”Använd likviddagen, inte brevdatumet” eller ”Värdena för vår enhet står i kolumnen Investor 0117”" style={{ fontFamily: 'inherit', fontSize: 14 }} />
      </label>
    </Modal>
  );
}

export function RuleModal({ issuer, initial, id, onClose, onSaved }: { issuer: string; initial?: string; id?: number; onClose: () => void; onSaved?: () => void }) {
  const [name, setName] = useState(issuer);
  const [text, setText] = useState(initial ?? '');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      if (id) await api.put(`/extraction-rules/${id}`, { issuer: name, instructions: text });
      else await api.post('/extraction-rules', { issuer: name, instructions: text });
      onSaved?.();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal title="Tolkningsregel" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Avbryt</button><button className="btn primary" onClick={save}>Spara regel</button></>}>
      <p className="small muted">Regeln skickas med till AI:n för alla dokument från denna avsändare. Beskriv med vanliga ord vad som brukar bli fel.</p>
      <div className="form-grid">
        <label className="field full">Avsändare (GP, fondbolag, bank)<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field full">Instruktion
          <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="T.ex. ”NAV efter carry står i kolumnen ’Partners’ capital – net’. Förfallodagen står som ’Value date’.”" style={{ fontFamily: 'inherit', fontSize: 14 }} />
        </label>
        {err && <div className="alert error full">{err}</div>}
      </div>
    </Modal>
  );
}
