import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../context';
import { AllocationCard, DataTable, ErrorBox, Kpi, Loading, type Allocations, type Column } from '../components/ui';
import { CashflowChart } from '../components/charts';
import TxForm from '../components/TxForm';
import { fmt, tone } from '../format';
import type { Instrument, PeHolding } from '../../../shared/types';

type Row = PeHolding & { instrument: Instrument; weight: number };
interface Resp {
  asOf: string;
  pe: Row[];
  summary: { commitment: number; paidIn: number; distributed: number; nav: number; uncalled: number; pnl: number; dpi: number | null; tvpi: number | null; irr: number | null };
  allocations: Allocations;
}

export default function PrivateEquity() {
  const { scopeQs, canEdit } = useApp();
  const nav = useNavigate();
  const [closed, setClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const { data, error } = useFetch<Resp>('/portfolio/holdings' + scopeQs({ type: 'PE_FUND', includeClosed: closed ? 1 : null }));
  const { data: cf } = useFetch<{ year: string; calls: number; distributions: number; cumulative: number }[]>('/portfolio/pe-cashflows' + scopeQs());
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const s = data.summary;
  const sum = (f: (r: Row) => number) => data.pe.reduce((a, r) => a + f(r), 0);

  const columns: Column<Row>[] = [
    {
      key: 'name', label: 'Fond', sortValue: (r) => r.instrument.name, footer: 'Summa (SEK)',
      render: (r) => (
        <div className="name-cell">
          <span>{r.instrument.name}</span>
          <span className="sub">{[r.instrument.strategy, r.instrument.vintage && `Vintage ${r.instrument.vintage}`, r.instrument.currency].filter(Boolean).join(' · ')}</span>
        </div>
      ),
    },
    { key: 'commit', label: 'Åtagande', num: true, sortValue: (r) => r.commitmentBase, render: (r) => fmt.int(r.commitment), footer: fmt.int(s.commitment) },
    { key: 'paid', label: 'Inbetalt', num: true, sortValue: (r) => r.paidInBase, render: (r) => <div className="name-cell"><span>{fmt.int(r.paidIn)}</span><span className="sub">{fmt.pct(r.calledPct)} anropat</span></div>, footer: fmt.int(s.paidIn) },
    { key: 'unc', label: 'Outnyttjat', num: true, sortValue: (r) => r.uncalledBase, render: (r) => fmt.int(r.uncalled), footer: fmt.int(s.uncalled) },
    { key: 'dist', label: 'Utdelat', num: true, sortValue: (r) => r.distributedBase, render: (r) => fmt.int(r.distributed), footer: fmt.int(s.distributed) },
    {
      key: 'nav', label: 'NAV', num: true, sortValue: (r) => r.navBase,
      render: (r) => (
        <span title={r.navEstimated ? `Senaste rapport ${r.navReportDate ?? 'saknas'}, framräknad med därefter anropat/utdelat` : `Rapport ${r.navReportDate}`}>
          {fmt.int(r.nav)}{r.navEstimated && <sup className="muted"> *</sup>}
        </span>
      ),
      footer: fmt.int(s.nav),
    },
    { key: 'navsek', label: 'NAV SEK', num: true, sortValue: (r) => r.navBase, render: (r) => fmt.int(r.navBase), footer: fmt.int(sum((r) => r.navBase)) },
    { key: 'dpi', label: 'DPI', num: true, title: 'Utdelat / inbetalt', sortValue: (r) => r.dpi, render: (r) => fmt.multiple(r.dpi), footer: fmt.multiple(s.dpi) },
    { key: 'tvpi', label: 'TVPI', num: true, title: '(Utdelat + NAV) / inbetalt', sortValue: (r) => r.tvpi, render: (r) => fmt.multiple(r.tvpi), footer: fmt.multiple(s.tvpi) },
    { key: 'irr', label: 'IRR lokal', num: true, title: 'Internränta i fondens valuta', sortValue: (r) => r.irr, render: (r) => <span className={tone(r.irr)}>{fmt.pct(r.irr)}</span> },
    { key: 'irrb', label: 'IRR SEK', num: true, title: 'Internränta i SEK (inkl. valutaeffekt)', sortValue: (r) => r.irrBase, render: (r) => <span className={tone(r.irrBase)}>{fmt.pct(r.irrBase)}</span>, footer: <span className={tone(s.irr)}>{fmt.pct(s.irr)}</span> },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>PE-fonder</h1>
          <p>Private equity-åtaganden per {data.asOf}. Belopp i fondens valuta, summor i SEK.</p>
        </div>
        {canEdit && <button className="btn primary" onClick={() => setAdding(true)}>+ Ny transaktion</button>}
      </div>
      <div className="kpis">
        <Kpi hero label="NAV" value={fmt.msek(s.nav)} sub={`${data.pe.length} fonder`} />
        <Kpi label="Åtaganden" value={fmt.msek(s.commitment)} sub={`Outnyttjat ${fmt.msek(s.uncalled)}`} />
        <Kpi label="Inbetalt / utdelat" value={`${fmt.msek(s.paidIn)}`} sub={`Utdelat ${fmt.msek(s.distributed)}`} />
        <Kpi label="TVPI / DPI" value={fmt.multiple(s.tvpi)} sub={`DPI ${fmt.multiple(s.dpi)}`} />
        <Kpi label="IRR (SEK)" value={fmt.pct(s.irr)} tone={tone(s.irr)} sub={`Resultat ${fmt.msek(s.pnl)}`} />
      </div>
      <div className="card">
        <DataTable
          rows={data.pe}
          columns={columns}
          rowKey={(r) => r.instrumentId}
          search={(r) => `${r.instrument.name} ${r.instrument.manager ?? ''} ${r.instrument.strategy ?? ''}`}
          searchPlaceholder="Sök fond, förvaltare eller strategi"
          defaultSort={{ key: 'navsek', dir: -1 }}
          onRowClick={(r) => nav(`/instrument/${r.instrumentId}`)}
          empty="Inga PE-åtaganden"
          toolbar={<label className="row small"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Visa avslutade</label>}
        />
        <div className="small muted" style={{ marginTop: 8 }}>* NAV framräknat: senast rapporterat NAV justerat med kapitalanrop och utdelningar efter rapportdatum.</div>
      </div>
      <div className="grid g-2 mt">
        <div className="card">
          <div className="card-head"><h2>Kassaflöden per år (SEK)</h2></div>
          {cf ? <CashflowChart data={cf} /> : <Loading />}
        </div>
        <AllocationCard allocations={data.allocations} initial="sector" title="Fördelning" exclude={['type', 'assetClass']} />
      </div>
      {adding && <TxForm onClose={() => setAdding(false)} />}
    </div>
  );
}
