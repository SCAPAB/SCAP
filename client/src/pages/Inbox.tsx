import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useApp, useFetch } from '../context';
import { DataTable, ErrorBox, Loading, Seg } from '../components/ui';
import { fmt } from '../format';
import { TX_LABELS, type Transaction } from '../../../shared/types';

export interface DocListRow {
  id: number; filename: string; mime: string; status: 'processing' | 'review' | 'done' | 'error' | 'manual'; doc_type: string | null; doc_type_label: string | null;
  issuer: string | null; summary: string | null; error: string | null; uploaded_at: string; uploader: string | null;
  funds: string | null; pending: number; prepared: number; approved: number; rejected: number; total: number;
}

export const STATUS: Record<DocListRow['status'], { label: string; cls: string }> = {
  processing: { label: 'Tolkas …', cls: '' },
  review: { label: 'Att granska', cls: 'warn' },
  manual: { label: 'Registrera manuellt', cls: 'warn' },
  done: { label: 'Klar', cls: 'ok' },
  error: { label: 'Fel', cls: 'err' },
};

const ACCEPT = ['application/pdf', 'image/png', 'image/jpeg'];

export default function Inbox() {
  const { canEdit, bump } = useApp();
  const nav = useNavigate();
  const [filter, setFilter] = useState<'todo' | 'all' | 'done'>('todo');
  const [tick, setTick] = useState(0);
  const { data, error } = useFetch<DocListRow[]>('/documents', [tick]);
  const { data: ai } = useFetch<{ enabled: boolean; model: string }>('/ai/status');
  const [uploads, setUploads] = useState<{ name: string; state: 'uploading' | 'ok' | 'dup' | 'error'; msg?: string; id?: number }[]>([]);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Uppdatera listan medan dokument tolkas
  const processing = data?.some((d) => d.status === 'processing');
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => setTick((x) => x + 1), 2000);
    return () => clearInterval(t);
  }, [processing]);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    setUploads((u) => [...list.map((f) => ({ name: f.name, state: 'uploading' as const })), ...u].slice(0, 20));
    for (const f of list) {
      const set = (patch: object) => setUploads((u) => u.map((x) => (x.name === f.name && x.state === 'uploading' ? { ...x, ...patch } : x)));
      if (!ACCEPT.includes(f.type)) { set({ state: 'error', msg: 'Endast PDF, PNG eller JPG' }); continue; }
      try {
        const data = await toBase64(f);
        const r = await api.post<{ id: number; duplicate: boolean; message?: string }>('/documents', { filename: f.name, mime: f.type, data });
        set({ state: r.duplicate ? 'dup' : 'ok', msg: r.message, id: r.id });
      } catch (e) {
        set({ state: 'error', msg: (e as Error).message });
      }
    }
    setTick((x) => x + 1);
    bump();
  };

  const rows = (data ?? []).filter((d) => filter === 'all' || (filter === 'done' ? d.status === 'done' : d.status !== 'done'));
  const todo = (data ?? []).filter((d) => d.status === 'review' || d.status === 'manual').length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Inkorg</h1>
          <p>Ladda upp underlag – kapitalanrop, utdelningar, kapitalkontoutdrag, avräkningsnotor, innehavsbesked. AI föreslår, du granskar och godkänner varje post.</p>
        </div>
        <div className="row">
          <Link className="btn" to="/inkorg/regler">Regler och inlärda namn</Link>
        </div>
      </div>
      {ai && !ai.enabled && (
        <div className="alert">AI-tolkning är inte aktiverad på servern (ANTHROPIC_API_KEY saknas). Dokument kan ändå laddas upp och poster registreras manuellt med samma kontroller och godkännande.</div>
      )}
      {canEdit && (
        <div
          className={'dropzone' + (drag ? ' drag' : '')}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files); }}
          onClick={() => input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        >
          <div className="dz-icon" aria-hidden>⬆</div>
          <strong>Släpp filer här eller klicka för att välja</strong>
          <div className="small muted">PDF, PNG eller JPG · flera filer samtidigt · samma fil kan inte laddas upp två gånger</div>
          <input ref={input} type="file" multiple accept=".pdf,.png,.jpg,.jpeg" hidden onChange={(e) => e.target.files && upload(e.target.files)} />
        </div>
      )}
      {uploads.length > 0 && (
        <div className="upload-list">
          {uploads.map((u, i) => (
            <div key={i} className="row small">
              <span className={'badge ' + (u.state === 'ok' ? 'ok' : u.state === 'error' ? 'err' : u.state === 'dup' ? 'warn' : '')}>
                {{ uploading: 'Laddar upp', ok: 'Uppladdad', dup: 'Redan uppladdad', error: 'Fel' }[u.state]}
              </span>
              <span>{u.name}</span>
              {u.msg && <span className="muted">– {u.msg}</span>}
              {u.id && <Link to={`/inkorg/${u.id}`}>Öppna</Link>}
            </div>
          ))}
        </div>
      )}
      <ErrorBox error={error} />
      <ChangeRequests />
      <div className="card mt">
        {!data ? <Loading /> : (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => nav(`/inkorg/${r.id}`)}
            search={(r) => `${r.filename} ${r.issuer ?? ''} ${r.summary ?? ''} ${r.doc_type_label ?? ''} ${r.funds ?? ''}`}
            searchPlaceholder="Sök dokument, avsändare"
            empty={filter === 'todo' ? 'Inget att granska just nu' : 'Inga dokument'}
            toolbar={<Seg value={filter} onChange={setFilter} options={[{ value: 'todo', label: `Att hantera (${todo})` }, { value: 'done', label: 'Klara' }, { value: 'all', label: 'Alla' }]} />}
            columns={[
              {
                key: 'doc', label: 'Dokument', sortValue: (r) => r.filename,
                render: (r) => (
                  <div className="name-cell" style={{ maxWidth: 520, whiteSpace: 'normal' }}>
                    <span>{r.filename}</span>
                    <span className="sub">{r.status === 'error' ? r.error : r.summary ?? (r.status === 'processing' ? 'AI läser dokumentet …' : '')}</span>
                  </div>
                ),
              },
              { key: 'type', label: 'Typ', sortValue: (r) => r.doc_type_label, render: (r) => r.doc_type_label ?? <span className="muted">–</span> },
              { key: 'issuer', label: 'Avsändare', sortValue: (r) => r.issuer, render: (r) => r.issuer ?? <span className="muted">–</span> },
              { key: 'funds', label: 'Avser', sortValue: (r) => r.funds, render: (r) => <span className="wrap-cell small" style={{ maxWidth: 220 }}>{r.funds?.split(',').join(', ') ?? <span className="muted">ej matchat</span>}</span> },
              {
                key: 'prog', label: 'Poster', num: true, sortValue: (r) => r.pending,
                render: (r) => (r.total ? <span title={`${r.approved} godkända, ${r.rejected} avvisade, ${r.pending} kvar`}>{r.approved + r.rejected} / {r.total}</span> : <span className="muted">–</span>),
              },
              { key: 'status', label: 'Status', sortValue: (r) => r.status, render: (r) => (r.status === 'review' && r.prepared > 0 && r.prepared === r.pending ? <span className="badge accent">Väntar på attest</span> : <span className={'badge ' + STATUS[r.status].cls}>{STATUS[r.status].label}</span>) },
              { key: 'up', label: 'Uppladdad', sortValue: (r) => r.uploaded_at, render: (r) => <span className="muted small">{r.uploaded_at.slice(0, 16)} · {r.uploader ?? '–'}</span> },
            ]}
          />
        )}
      </div>
    </div>
  );
}

interface ChangeRequest {
  id: number; transaction_id: number; action: 'update' | 'delete'; payload: Partial<Transaction> | null; requested_by: number | null; requested_by_name: string | null;
  requested_at: string; comment: string | null; transaction: (Transaction & { instrument_name: string; currency: string }) | null;
}

const CHANGE_FIELDS: [keyof Transaction, string][] = [
  ['type', 'Typ'], ['trade_date', 'Affärsdag'], ['settle_date', 'Likviddag'], ['quantity', 'Antal'], ['price', 'Kurs'], ['amount', 'Belopp'], ['fee', 'Avgift'],
  ['fx_rate', 'Valutakurs'], ['outside_commitment', 'Varav utanför åtagandet'], ['recallable', 'Varav återinkallningsbart'], ['instrument_id', 'Instrument (id)'], ['note', 'Notering'],
];
const show = (v: unknown) => (v == null || v === '' ? '–' : typeof v === 'number' ? fmt.dec(v) : String(v));

/** Ändringar och borttag av attesterade transaktioner som väntar på attest av en annan användare (fyra ögon). */
function ChangeRequests() {
  const { me, canEdit, bump } = useApp();
  const [tick, setTick] = useState(0);
  const { data } = useFetch<ChangeRequest[]>('/change-requests?status=pending', [tick]);
  const [err, setErr] = useState<string | null>(null);
  if (!data || data.length === 0) return null;
  const act = async (c: ChangeRequest, what: 'approve' | 'reject') => {
    setErr(null);
    const comment = what === 'reject' ? prompt('Varför avvisas ändringen? (valfritt)') : null;
    if (what === 'reject' && comment === null) return;
    try {
      await api.post(`/change-requests/${c.id}/${what}`, { comment });
      setTick((x) => x + 1);
      bump();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="card mt">
      <div className="card-head"><h2>Ändringar som väntar på attest</h2></div>
      <p className="small muted">Attesterade transaktioner ändras eller tas bort först när en annan användare än den som begärde ändringen har attesterat den. Båda namnen loggas.</p>
      <ErrorBox error={err} />
      <DataTable
        rows={data}
        rowKey={(c) => c.id}
        columns={[
          {
            key: 't', label: 'Transaktion', render: (c) => c.transaction ? (
              <div className="name-cell"><Link to={`/instrument/${c.transaction.instrument_id}`}>{c.transaction.instrument_name}</Link><span className="sub">#{c.transaction_id} · {TX_LABELS[c.transaction.type]} · {c.transaction.trade_date}</span></div>
            ) : <span className="muted">#{c.transaction_id} (finns inte längre)</span>,
          },
          {
            key: 'c', label: 'Ändring', render: (c) => c.action === 'delete' ? <span className="badge err">Borttag</span> : (
              <div className="small">
                {CHANGE_FIELDS.filter(([k]) => c.transaction && c.payload && String(c.payload[k] ?? '') !== String(c.transaction[k] ?? '')).map(([k, label]) => (
                  <div key={k}>{label}: {show(c.transaction![k])} → <strong>{show(c.payload![k])}</strong></div>
                ))}
              </div>
            ),
          },
          { key: 'r', label: 'Begärd av', render: (c) => <div className="name-cell"><span>{c.requested_by_name ?? '–'}</span><span className="sub">{c.requested_at.slice(0, 16)}</span></div> },
          { key: 'k', label: 'Kommentar', render: (c) => <span className="muted small">{c.comment ?? ''}</span> },
          {
            key: 'a', label: '', render: (c) => canEdit ? (
              <div className="row">
                <button className="btn small primary" disabled={c.requested_by === me.id} title={c.requested_by === me.id ? 'Du har begärt ändringen – en annan användare måste attestera' : undefined} onClick={() => act(c, 'approve')}>Attestera</button>
                <button className="btn small" onClick={() => act(c, 'reject')}>Avvisa</button>
              </div>
            ) : null,
          },
        ]}
      />
    </div>
  );
}

function toBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Kunde inte läsa filen'));
    r.readAsDataURL(f);
  });
}
