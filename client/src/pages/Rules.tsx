import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApp, useFetch } from '../context';
import { DataTable, ErrorBox, Loading } from '../components/ui';
import { RuleModal } from './Review';

interface Rule { id: number; issuer: string; instructions: string; updated_at: string; updated_by_name: string | null }

export default function Rules() {
  const { canEdit } = useApp();
  const [tick, setTick] = useState(0);
  const { data, error } = useFetch<Rule[]>('/extraction-rules', [tick]);
  const [edit, setEdit] = useState<Rule | 'new' | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <div>
      <div className="page-head">
        <div>
          <div className="small"><Link to="/inkorg">← Inkorg</Link></div>
          <h1>Tolkningsregler och inlärda namn</h1>
          <p>Avsändarspecifika instruktioner som skickas med till AI:n. Lägg till en regel när samma fel återkommer från en GP, ett fondbolag eller en bank.</p>
        </div>
        {canEdit && <button className="btn primary" onClick={() => setEdit('new')}>+ Ny regel</button>}
      </div>
      <div className="card">
        <DataTable
          rows={data}
          rowKey={(r) => r.id}
          onRowClick={canEdit ? (r) => setEdit(r) : undefined}
          empty="Inga regler ännu"
          columns={[
            { key: 'i', label: 'Avsändare', render: (r) => <strong>{r.issuer}</strong> },
            { key: 't', label: 'Instruktion', render: (r) => <span className="wrap-cell">{r.instructions}</span> },
            { key: 'u', label: 'Senast ändrad', render: (r) => <span className="muted small">{r.updated_at.slice(0, 16)} · {r.updated_by_name ?? '–'}</span> },
            ...(canEdit ? [{ key: 'x', label: '', render: (r: Rule) => <button className="btn small ghost danger" onClick={async (e) => { e.stopPropagation(); if (confirm('Ta bort regeln?')) { await api.del(`/extraction-rules/${r.id}`); setTick((x) => x + 1); } }}>Ta bort</button> }] : []),
          ]}
        />
      </div>
      <Aliases />
      {edit && (
        <RuleModal
          issuer={edit === 'new' ? '' : edit.issuer}
          initial={edit === 'new' ? '' : edit.instructions}
          id={edit === 'new' ? undefined : edit.id}
          onClose={() => setEdit(null)}
          onSaved={() => setTick((x) => x + 1)}
        />
      )}
    </div>
  );
}

interface Alias { id: number; kind: 'instrument' | 'entity'; raw: string; issuer: string | null; target_name: string | null; created_at: string; created_by_name: string | null }

/** Namn som systemet lärt sig när användare godkänt matchningar. */
function Aliases() {
  const { canEdit } = useApp();
  const [tick, setTick] = useState(0);
  const { data } = useFetch<Alias[]>('/aliases', [tick]);
  if (!data) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Inlärda namn</h2>
        <span className="small muted">Skapas automatiskt när en matchning godkänns. Nästa dokument med samma namn från samma avsändare matchas då säkert.</span>
      </div>
      <DataTable
        rows={data}
        rowKey={(a) => a.id}
        empty="Inga inlärda namn ännu"
        search={(a) => `${a.raw} ${a.issuer ?? ''} ${a.target_name ?? ''}`}
        columns={[
          { key: 'r', label: 'Namn i dokumentet', render: (a) => <strong>{a.raw}</strong> },
          { key: 'k', label: 'Avser', render: (a) => <span className="badge">{a.kind === 'instrument' ? 'Instrument' : 'Investerare'}</span> },
          { key: 't', label: 'Kopplat till', render: (a) => a.target_name ?? '–' },
          { key: 'i', label: 'Gäller avsändare', render: (a) => a.issuer ?? <span className="muted">alla</span> },
          { key: 'u', label: 'Inlärt', render: (a) => <span className="muted small">{a.created_at.slice(0, 16)} · {a.created_by_name ?? '–'}</span> },
          ...(canEdit ? [{ key: 'x', label: '', render: (a: Alias) => <button className="btn small ghost danger" onClick={async () => { if (confirm('Ta bort det inlärda namnet?')) { await api.del(`/aliases/${a.id}`); setTick((x) => x + 1); } }}>Ta bort</button> }] : []),
        ]}
      />
    </div>
  );
}
