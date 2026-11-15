import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, useFetch } from '../context';
import { DataTable, ErrorBox, Loading } from '../components/ui';
import TxForm from '../components/TxForm';
import { fmt } from '../format';
import { TX_LABELS, TYPE_LABELS, type InstrumentType, type Transaction, type TxType } from '../../../shared/types';

type Row = Transaction & { document_id: number | null; instrument_name: string; currency: string; instrument_type: InstrumentType; entity_name: string };

export default function Transactions() {
  const { scope, canEdit } = useApp();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState('');
  const [assetType, setAssetType] = useState('');
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const params = new URLSearchParams();
  if (scope.entities) params.set('entities', scope.entities);
  for (const [k, v] of Object.entries({ from, to, type, assetType })) if (v) params.set(k, v);
  params.set('limit', '5000');
  const { data, error } = useFetch<Row[]>('/transactions?' + params.toString());
  const exportQs = new URLSearchParams();
  if (scope.entities) exportQs.set('entities', scope.entities);
  if (from) exportQs.set('from', from);
  if (to) exportQs.set('to', to);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Transaktioner</h1>
          <p>Alla affärer, utdelningar, avgifter, åtaganden, kapitalanrop och utdelningar från PE-fonder.</p>
        </div>
        <div className="row">
          <a className="btn" href={`/api/reports/transactions.csv?${exportQs}`}>Exportera CSV</a>
          {canEdit && <button className="btn primary" onClick={() => setEdit('new')}>+ Ny transaktion</button>}
        </div>
      </div>
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="field">Från<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field">Till<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="field">Förvaltningsform
            <select value={assetType} onChange={(e) => setAssetType(e.target.value)}>
              <option value="">Alla</option><option value="EQUITY">Direktägda aktier</option><option value="FUND">Öppna fonder</option><option value="PE_FUND">Slutna fonder</option>
            </select>
          </label>
          <label className="field">Typ
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Alla</option>
              {(Object.keys(TX_LABELS) as TxType[]).map((t) => <option key={t} value={t}>{TX_LABELS[t]}</option>)}
            </select>
          </label>
        </div>
        <ErrorBox error={error} />
        {!data ? <Loading /> : (
          <DataTable
            rows={data}
            rowKey={(r) => r.id}
            search={(r) => `${r.instrument_name} ${r.entity_name} ${r.note ?? ''}`}
            searchPlaceholder="Sök instrument, enhet eller notering"
            onRowClick={canEdit ? (r) => setEdit(r) : undefined}
            pageSize={50}
            columns={[
              { key: 'd', label: 'Affärsdag', sortValue: (r) => r.trade_date, render: (r) => r.trade_date },
              { key: 'e', label: 'Enhet', sortValue: (r) => r.entity_name, render: (r) => r.entity_name },
              { key: 'i', label: 'Instrument', sortValue: (r) => r.instrument_name, render: (r) => <Link to={`/instrument/${r.instrument_id}`} onClick={(e) => e.stopPropagation()}>{r.instrument_name}</Link> },
              { key: 'k', label: 'Slag', render: (r) => <span className="badge">{TYPE_LABELS[r.instrument_type]}</span> },
              { key: 't', label: 'Typ', sortValue: (r) => r.type, render: (r) => TX_LABELS[r.type] },
              { key: 'q', label: 'Antal', num: true, sortValue: (r) => r.quantity, render: (r) => (r.quantity ? fmt.qty(r.quantity) : '') },
              { key: 'p', label: 'Kurs', num: true, render: (r) => (r.price ? fmt.price(r.price) : '') },
              { key: 'a', label: 'Belopp', num: true, sortValue: (r) => r.amount, render: (r) => fmt.dec(r.amount) },
              { key: 'c', label: 'Valuta', render: (r) => r.currency },
              { key: 'sek', label: 'Belopp SEK', num: true, sortValue: (r) => r.amount * r.fx_rate, render: (r) => fmt.int(r.amount * r.fx_rate) },
              { key: 'n', label: 'Notering', render: (r) => <span className="muted">{r.note}</span> },
              { key: 'src', label: 'Källa', render: (r) => (r.document_id ? <Link to={`/inkorg/${r.document_id}`} onClick={(e) => e.stopPropagation()} title="Öppna underlaget">Dokument</Link> : <span className="muted small">Manuell</span>) },
            ]}
          />
        )}
      </div>
      {edit && <TxForm initial={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
