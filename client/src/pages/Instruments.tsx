import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, useFetch } from '../context';
import { DataTable, ErrorBox, Loading, Seg } from '../components/ui';
import InstrumentForm from '../components/InstrumentForm';
import { fmt } from '../format';
import { TYPE_LABELS, type Instrument, type InstrumentType } from '../../../shared/types';

type Row = Instrument & { lastPrice: { date: string; value: number } | null };

export default function Instruments() {
  const { canEdit } = useApp();
  const [type, setType] = useState<'' | InstrumentType>('');
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const { data, error } = useFetch<Row[]>('/instruments');
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const rows = data.filter((i) => !type || i.type === type);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Instrument</h1>
          <p>Register över värdepapper. Klassificering styr fördelningsrapporterna.</p>
        </div>
        {canEdit && <button className="btn primary" onClick={() => setEdit('new')}>+ Nytt instrument</button>}
      </div>
      <div className="card">
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          search={(r) => `${r.name} ${r.isin ?? ''} ${r.ticker ?? ''} ${r.manager ?? ''}`}
          searchPlaceholder="Sök namn, ISIN, ticker"
          defaultSort={{ key: 'name', dir: 1 }}
          onRowClick={canEdit ? (r) => setEdit(r) : undefined}
          toolbar={<Seg value={type} onChange={setType} options={[{ value: '', label: 'Alla' }, { value: 'EQUITY', label: 'Aktier' }, { value: 'FUND', label: 'Fonder' }, { value: 'PE_FUND', label: 'PE-fonder' }]} />}
          columns={[
            { key: 'name', label: 'Namn', sortValue: (r) => r.name, render: (r) => <Link to={`/instrument/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link> },
            { key: 'type', label: 'Typ', sortValue: (r) => r.type, render: (r) => <span className="badge">{TYPE_LABELS[r.type]}</span> },
            { key: 'isin', label: 'ISIN', sortValue: (r) => r.isin, render: (r) => r.isin ?? <span className="muted">–</span> },
            { key: 'ccy', label: 'Valuta', sortValue: (r) => r.currency, render: (r) => r.currency },
            { key: 'region', label: 'Region', sortValue: (r) => r.region, render: (r) => r.region ?? '–' },
            { key: 'sector', label: 'Bransch/inriktning', sortValue: (r) => r.sector, render: (r) => r.sector ?? '–' },
            { key: 'mgr', label: 'Förvaltare', sortValue: (r) => r.manager, render: (r) => r.manager ?? '–' },
            { key: 'px', label: 'Senaste kurs', num: true, render: (r) => (r.type === 'PE_FUND' ? <span className="muted">NAV</span> : r.lastPrice ? fmt.price(r.lastPrice.value) : '–') },
            { key: 'pxd', label: 'Kursdatum', sortValue: (r) => r.lastPrice?.date ?? null, render: (r) => <span className="muted">{r.lastPrice?.date ?? ''}</span> },
          ]}
        />
      </div>
      {edit && <InstrumentForm initial={edit === 'new' ? undefined : edit} defaultType={type || 'EQUITY'} onClose={() => setEdit(null)} />}
    </div>
  );
}
