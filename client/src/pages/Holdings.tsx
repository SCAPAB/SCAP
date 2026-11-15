import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../context';
import { AllocationCard, DataTable, ErrorBox, Kpi, Loading, type Allocations, type Column } from '../components/ui';
import TxForm from '../components/TxForm';
import { fmt, tone } from '../format';
import type { Instrument, ListedHolding } from '../../../shared/types';

type Row = ListedHolding & { instrument: Instrument; weight: number };
interface Resp {
  asOf: string;
  listed: Row[];
  summary: { marketValue: number; cost: number; unrealized: number; realized: number; dividends: number; fees: number; fxEffect: number; totalPnl: number };
  allocations: Allocations;
}

export default function Holdings({ type }: { type: 'EQUITY' | 'FUND' }) {
  const { scopeQs, canEdit } = useApp();
  const [closed, setClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  const { data, error } = useFetch<Resp>('/portfolio/holdings' + scopeQs({ type, includeClosed: closed ? 1 : null }));
  const title = type === 'EQUITY' ? 'Aktier' : 'Fonder';
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const s = data.summary;
  const sum = (f: (r: Row) => number) => data.listed.reduce((a, r) => a + f(r), 0);

  const columns: Column<Row>[] = [
    {
      key: 'name', label: 'Namn', sortValue: (r) => r.instrument.name,
      render: (r) => (
        <div className="name-cell">
          <span>{r.instrument.name}</span>
          <span className="sub">{[r.instrument.isin, type === 'FUND' ? r.instrument.fund_category : r.instrument.sector].filter(Boolean).join(' · ')}</span>
        </div>
      ),
      footer: 'Summa',
    },
    { key: 'qty', label: 'Antal', num: true, sortValue: (r) => r.quantity, render: (r) => fmt.qty(r.quantity) },
    { key: 'gav', label: 'GAV', num: true, title: 'Genomsnittligt anskaffningsvärde per andel, lokal valuta, inkl. courtage', sortValue: (r) => r.avgCostLocal, render: (r) => fmt.price(r.avgCostLocal) },
    { key: 'price', label: 'Kurs', num: true, sortValue: (r) => r.price, render: (r) => <span title={`Kursdatum ${r.priceDate ?? '–'}`}>{fmt.price(r.price)}</span> },
    { key: 'ccy', label: 'Valuta', sortValue: (r) => r.instrument.currency, render: (r) => r.instrument.currency },
    { key: 'cost', label: 'Ansk.värde SEK', num: true, sortValue: (r) => r.costBase, render: (r) => fmt.int(r.costBase), footer: fmt.int(sum((r) => r.costBase)) },
    { key: 'mv', label: 'Marknadsvärde SEK', num: true, sortValue: (r) => r.mvBase, render: (r) => fmt.int(r.mvBase), footer: fmt.int(sum((r) => r.mvBase)) },
    { key: 'unr', label: 'Orealiserat SEK', num: true, sortValue: (r) => r.unrealizedBase, render: (r) => <span className={tone(r.unrealizedBase)}>{fmt.int(r.unrealizedBase)}</span>, footer: <span className={tone(s.unrealized)}>{fmt.int(s.unrealized)}</span> },
    { key: 'unrp', label: 'Orealiserat %', num: true, sortValue: (r) => r.unrealizedPct, render: (r) => <span className={tone(r.unrealizedPct)}>{fmt.signedPct(r.unrealizedPct)}</span> },
    { key: 'fx', label: 'Varav valuta', num: true, title: 'Del av orealiserat resultat som beror på valutakursförändring', sortValue: (r) => r.fxEffectBase, render: (r) => (r.instrument.currency === 'SEK' ? <span className="muted">–</span> : fmt.int(r.fxEffectBase)) },
    ...(type === 'EQUITY' ? [{ key: 'div', label: 'Utdelningar SEK', num: true, sortValue: (r: Row) => r.dividendsBase, render: (r: Row) => fmt.int(r.dividendsBase), footer: fmt.int(s.dividends) }] : []),
    { key: 'w', label: 'Andel', num: true, title: 'Andel av total portfölj', sortValue: (r) => r.weight, render: (r) => fmt.pct(r.weight) },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p>{type === 'EQUITY' ? 'Direktägda noterade aktier' : 'Aktie- och räntefonder'} per {data.asOf}. Anskaffningsvärde enligt genomsnittsmetoden.</p>
        </div>
        {canEdit && <button className="btn primary" onClick={() => setAdding(true)}>+ Ny transaktion</button>}
      </div>
      <div className="kpis">
        <Kpi hero label="Marknadsvärde" value={fmt.msek(s.marketValue)} sub={`Anskaffningsvärde ${fmt.msek(s.cost)}`} />
        <Kpi label="Orealiserat resultat" value={fmt.msek(s.unrealized)} tone={tone(s.unrealized)} sub={`${fmt.signedPct(s.cost ? s.unrealized / s.cost : null)} · varav valuta ${fmt.msek(s.fxEffect)}`} />
        <Kpi label="Realiserat resultat" value={fmt.msek(s.realized)} tone={tone(s.realized)} sub="Sedan start" />
        {type === 'EQUITY' && <Kpi label="Utdelningar" value={fmt.msek(s.dividends)} sub="Netto efter källskatt, sedan start" />}
        <Kpi label="Totalt resultat" value={fmt.msek(s.totalPnl)} tone={tone(s.totalPnl)} sub="Orealiserat + realiserat + utdelningar − avgifter" />
      </div>
      <div className="card">
        <DataTable
          rows={data.listed}
          columns={columns}
          rowKey={(r) => r.instrumentId}
          search={(r) => `${r.instrument.name} ${r.instrument.isin ?? ''} ${r.instrument.ticker ?? ''} ${r.instrument.currency}`}
          searchPlaceholder="Sök namn, ISIN eller valuta"
          defaultSort={{ key: 'mv', dir: -1 }}
          onRowClick={(r) => nav(`/instrument/${r.instrumentId}`)}
          empty="Inga innehav"
          toolbar={<label className="row small"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Visa avslutade</label>}
        />
      </div>
      <div className="grid g-2 mt">
        <AllocationCard allocations={data.allocations} initial={type === 'EQUITY' ? 'sector' : 'region'} exclude={['type', 'assetClass']} />
        <AllocationCard allocations={data.allocations} initial="currency" title="Fördelning – alternativ vy" exclude={['type', 'assetClass']} />
      </div>
      {adding && <TxForm onClose={() => setAdding(false)} />}
    </div>
  );
}
