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
          <h1>Tolkningsregler</h1>
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
