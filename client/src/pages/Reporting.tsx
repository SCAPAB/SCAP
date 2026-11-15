import { Link } from 'react-router-dom';
import { useApp, useFetch } from '../context';
import { DataTable, ErrorBox, Kpi, Loading } from '../components/ui';
import { ASSET_CLASS_LABEL, type AssetClass } from '../../../shared/types';

interface Row { entityId: number; entity: string; instrumentId: number; fund: string; manager: string | null; assetClass: AssetClass; latest: string | null; documentId: number | null; status: 'received' | 'awaiting' | 'overdue'; daysLate: number }
interface Resp { asOf: string; latestQuarter: string; due: string; lag: number; rows: Row[] }

const ST = {
  received: { t: 'Mottagen', c: 'ok' },
  awaiting: { t: 'Väntar – inom rapporteringstid', c: '' },
  overdue: { t: 'Försenad', c: 'err' },
};

/** Bevakning av kvartalsrapporter (NAV/kapitalkontoutdrag) från förvaltarna. */
export default function Reporting() {
  const { scopeQs } = useApp();
  const { data, error } = useFetch<Resp>('/portfolio/reporting' + scopeQs());
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const n = (s: Row['status']) => data.rows.filter((r) => r.status === s).length;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Rapportbevakning</h1>
          <p>
            Kvartalsrapporter (kapitalkontoutdrag/NAV) per åtagande. Senaste kvartal: <strong>{data.latestQuarter}</strong>. Rapporter räknas som försenade
            {' '}{data.lag} dagar efter kvartalsslut (senast förfallna kvartal: {data.due}).
          </p>
        </div>
        <Link className="btn primary" to="/inkorg">Ladda upp rapporter</Link>
      </div>
      <div className="kpis">
        <Kpi label="Mottagna för senaste kvartalet" value={`${n('received')} av ${data.rows.length}`} tone={n('received') === data.rows.length ? 'pos' : ''} />
        <Kpi label="Väntar (inom rapporteringstid)" value={String(n('awaiting'))} />
        <Kpi label="Försenade" value={String(n('overdue'))} tone={n('overdue') ? 'neg' : 'pos'} sub={n('overdue') ? 'Påminn förvaltaren' : 'Inga förseningar'} />
      </div>
      <div className="card">
        <DataTable
          rows={data.rows}
          rowKey={(r) => `${r.entityId}-${r.instrumentId}`}
          search={(r) => `${r.fund} ${r.manager ?? ''} ${r.entity}`}
          searchPlaceholder="Sök fond, förvaltare eller enhet"
          columns={[
            { key: 'f', label: 'Fond', sortValue: (r) => r.fund, render: (r) => <div className="name-cell"><Link to={`/instrument/${r.instrumentId}`}>{r.fund}</Link><span className="sub">{ASSET_CLASS_LABEL[r.assetClass]}</span></div> },
            { key: 'm', label: 'Förvaltare (GP)', sortValue: (r) => r.manager, render: (r) => r.manager ?? '–' },
            { key: 'l', label: 'Senaste NAV', sortValue: (r) => r.latest, render: (r) => r.latest ?? <span className="muted">saknas</span> },
            { key: 'd', label: 'Underlag', render: (r) => (r.documentId ? <Link to={`/inkorg/${r.documentId}`}>Dokument</Link> : <span className="muted small">ej uppladdat</span>) },
            { key: 's', label: 'Status', sortValue: (r) => r.status, render: (r) => <span className={'badge ' + ST[r.status].c}>{ST[r.status].t}{r.status === 'overdue' ? ` (${r.daysLate} d)` : ''}</span> },
          ]}
        />
      </div>
    </div>
  );
}
