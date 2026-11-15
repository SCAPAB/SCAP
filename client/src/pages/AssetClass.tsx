import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useApp, useFetch } from '../context';
import { AllocationCard, DataTable, ErrorBox, Kpi, Loading, type Allocations, type Column } from '../components/ui';
import { CashflowChart } from '../components/charts';
import TxForm from '../components/TxForm';
import { fmt, tone } from '../format';
import { ASSET_CLASSES, TYPE_LABELS, type Instrument, type ListedHolding, type PeHolding } from '../../../shared/types';

type LRow = ListedHolding & { instrument: Instrument; weight: number };
type PRow = PeHolding & { instrument: Instrument; weight: number };
interface Resp {
  asOf: string;
  listed: LRow[];
  pe: PRow[];
  total: { value: number; share: number; portfolio: number; uncalled: number; policy: { target: number; min: number; max: number } | null };
  listedSummary: { marketValue: number; cost: number; unrealized: number; realized: number; dividends: number; fees: number; fxEffect: number; totalPnl: number } | null;
  privateSummary: { commitment: number; paidIn: number; distributed: number; nav: number; uncalled: number; pnl: number; dpi: number | null; tvpi: number | null; irr: number | null } | null;
  allocations: Allocations;
}

/** Ett tillgångsslag – alla innehav oavsett förvaltningsform (direktägt, öppen fond, sluten fond). */
export default function AssetClass() {
  const { path } = useParams();
  const meta = ASSET_CLASSES.find((a) => a.path === path);
  const { scopeQs, canEdit } = useApp();
  const nav = useNavigate();
  const [closed, setClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const { data, error } = useFetch<Resp>(meta ? '/portfolio/holdings' + scopeQs({ assetClass: meta.key, includeClosed: closed ? 1 : null }) : null);
  const { data: cf } = useFetch<{ year: string; calls: number; distributions: number; cumulative: number }[]>(meta ? '/portfolio/pe-cashflows' + scopeQs({ assetClass: meta.key }) : null);
  if (!meta) return <Navigate to="/" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const { total, listedSummary: ls, privateSummary: ps } = data;
  const pol = total.policy;
  const status = pol ? (total.share < pol.min ? 'under' : total.share > pol.max ? 'over' : 'ok') : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="small muted">Tillgångsslag</div>
          <h1>{meta.label}</h1>
          <p>Alla innehav i tillgångsslaget per {data.asOf}, oavsett om de ägs direkt, via öppna fonder eller via slutna fonder.</p>
        </div>
        {canEdit && <button className="btn primary" onClick={() => setAdding(true)}>+ Ny transaktion</button>}
      </div>
      <div className="kpis">
        <Kpi hero label="Marknadsvärde" value={fmt.msek(total.value)} sub={`${data.listed.length + data.pe.length} innehav`} />
        <Kpi
          label="Andel av portföljen"
          value={fmt.pct(total.share)}
          sub={pol ? <>Policy {fmt.pct(pol.target, 0)} ({fmt.pct(pol.min, 0)}–{fmt.pct(pol.max, 0)}) · <span className={status === 'ok' ? 'pos' : 'neg'}>{status === 'ok' ? 'inom intervall' : status === 'over' ? 'över intervall' : 'under intervall'}</span></> : 'Ingen policyvikt'}
        />
        {ls && <Kpi label="Orealiserat (noterat)" value={fmt.msek(ls.unrealized)} tone={tone(ls.unrealized)} sub={`${fmt.signedPct(ls.cost ? ls.unrealized / ls.cost : null)} · varav valuta ${fmt.msek(ls.fxEffect)}`} />}
        {ps && <Kpi label="TVPI / DPI" value={fmt.multiple(ps.tvpi)} sub={`DPI ${fmt.multiple(ps.dpi)} · IRR ${fmt.pct(ps.irr)}`} />}
        {ps && <Kpi label="Outnyttjade åtaganden" value={fmt.msek(ps.uncalled)} sub={`Exponering inkl. åtaganden ${fmt.msek(total.value + ps.uncalled)}`} />}
        {ls && !ps && <Kpi label="Totalt resultat" value={fmt.msek(ls.totalPnl)} tone={tone(ls.totalPnl)} sub="Orealiserat + realiserat + utdelningar − avgifter" />}
      </div>

      {data.listed.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>{data.pe.length ? 'Noterade innehav och öppna fonder' : 'Innehav'}</h2>
            <label className="row small"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Visa avslutade</label>
          </div>
          <ListedTable rows={data.listed} summary={ls!} onOpen={(id) => nav(`/instrument/${id}`)} />
        </div>
      )}
      {data.pe.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Slutna fonder (åtaganden)</h2>
            {!data.listed.length && <label className="row small"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Visa avslutade</label>}
          </div>
          <PrivateTable rows={data.pe} summary={ps!} onOpen={(id) => nav(`/instrument/${id}`)} />
          <div className="small muted" style={{ marginTop: 8 }}>
            * NAV framräknat: senaste rapporterade NAV justerat för kapitalanrop (investeringsdel) och utdelningar efter rapportdatum. Saknade rapporter syns under <Link to="/rapportbevakning">Rapportbevakning</Link>.
          </div>
        </div>
      )}
      {!data.listed.length && !data.pe.length && <div className="card empty">Inga innehav i tillgångsslaget.</div>}

      <div className="grid g-2 mt">
        <AllocationCard allocations={data.allocations} initial="subClass" title="Fördelning" exclude={['assetClass']} />
        {ps && cf && cf.length > 0 ? (
          <div className="card">
            <div className="card-head"><h2>Kassaflöden per år (SEK)</h2></div>
            <CashflowChart data={cf} />
          </div>
        ) : (
          <AllocationCard allocations={data.allocations} initial="currency" title="Fördelning – alternativ vy" exclude={['assetClass']} />
        )}
      </div>
      {adding && <TxForm onClose={() => setAdding(false)} />}
    </div>
  );
}

function ListedTable({ rows, summary: s, onOpen }: { rows: LRow[]; summary: NonNullable<Resp['listedSummary']>; onOpen: (id: number) => void }) {
  const sum = (f: (r: LRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const columns: Column<LRow>[] = [
    {
      key: 'name', label: 'Namn', sortValue: (r) => r.instrument.name, footer: 'Summa',
      render: (r) => (
        <div className="name-cell">
          <span>{r.instrument.name}</span>
          <span className="sub">{[TYPE_LABELS[r.instrument.type], r.instrument.sub_class, r.instrument.isin].filter(Boolean).join(' · ')}</span>
        </div>
      ),
    },
    { key: 'qty', label: 'Antal', num: true, sortValue: (r) => r.quantity, render: (r) => fmt.qty(r.quantity) },
    { key: 'gav', label: 'GAV', num: true, title: 'Genomsnittligt anskaffningsvärde per andel, lokal valuta, inkl. courtage', sortValue: (r) => r.avgCostLocal, render: (r) => fmt.price(r.avgCostLocal) },
    { key: 'price', label: 'Kurs', num: true, sortValue: (r) => r.price, render: (r) => <span title={`Kursdatum ${r.priceDate ?? '–'}`}>{fmt.price(r.price)}</span> },
    { key: 'ccy', label: 'Valuta', sortValue: (r) => r.instrument.currency, render: (r) => r.instrument.currency },
    { key: 'cost', label: 'Ansk.värde SEK', num: true, sortValue: (r) => r.costBase, render: (r) => fmt.int(r.costBase), footer: fmt.int(sum((r) => r.costBase)) },
    { key: 'mv', label: 'Marknadsvärde SEK', num: true, sortValue: (r) => r.mvBase, render: (r) => fmt.int(r.mvBase), footer: fmt.int(sum((r) => r.mvBase)) },
    { key: 'unr', label: 'Orealiserat SEK', num: true, sortValue: (r) => r.unrealizedBase, render: (r) => <span className={tone(r.unrealizedBase)}>{fmt.int(r.unrealizedBase)}</span>, footer: <span className={tone(s.unrealized)}>{fmt.int(s.unrealized)}</span> },
    { key: 'unrp', label: '%', num: true, sortValue: (r) => r.unrealizedPct, render: (r) => <span className={tone(r.unrealizedPct)}>{fmt.signedPct(r.unrealizedPct)}</span> },
    { key: 'fx', label: 'Varav valuta', num: true, title: 'Del av orealiserat resultat som beror på valutakursförändring', sortValue: (r) => r.fxEffectBase, render: (r) => (r.instrument.currency === 'SEK' ? <span className="muted">–</span> : fmt.int(r.fxEffectBase)) },
    { key: 'div', label: 'Utdelningar SEK', num: true, sortValue: (r) => r.dividendsBase, render: (r) => fmt.int(r.dividendsBase), footer: fmt.int(s.dividends) },
    { key: 'w', label: 'Andel', num: true, title: 'Andel av total portfölj', sortValue: (r) => r.weight, render: (r) => fmt.pct(r.weight) },
  ];
  return (
    <DataTable rows={rows} columns={columns} rowKey={(r) => r.instrumentId} defaultSort={{ key: 'mv', dir: -1 }} onRowClick={(r) => onOpen(r.instrumentId)}
      search={(r) => `${r.instrument.name} ${r.instrument.isin ?? ''} ${r.instrument.ticker ?? ''} ${r.instrument.currency} ${r.instrument.sub_class ?? ''}`} searchPlaceholder="Sök namn, ISIN, valuta eller segment" />
  );
}

function PrivateTable({ rows, summary: s, onOpen }: { rows: PRow[]; summary: NonNullable<Resp['privateSummary']>; onOpen: (id: number) => void }) {
  const columns: Column<PRow>[] = [
    {
      key: 'name', label: 'Fond', sortValue: (r) => r.instrument.name, footer: 'Summa (SEK)',
      render: (r) => (
        <div className="name-cell">
          <span>{r.instrument.name}</span>
          <span className="sub">{[r.instrument.manager, r.instrument.sub_class, r.instrument.vintage && `Vintage ${r.instrument.vintage}`, r.instrument.currency].filter(Boolean).join(' · ')}</span>
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
        <div className="name-cell">
          <span>{fmt.int(r.nav)}{r.navEstimated && <sup className="muted"> *</sup>}</span>
          <span className="sub">{r.navReportDate ? `rapport ${r.navReportDate}` : 'ingen rapport'}</span>
        </div>
      ),
    },
    { key: 'navsek', label: 'NAV SEK', num: true, sortValue: (r) => r.navBase, render: (r) => fmt.int(r.navBase), footer: fmt.int(s.nav) },
    { key: 'dpi', label: 'DPI', num: true, title: 'Utdelat / inbetalt', sortValue: (r) => r.dpi, render: (r) => fmt.multiple(r.dpi), footer: fmt.multiple(s.dpi) },
    { key: 'tvpi', label: 'TVPI', num: true, title: '(Utdelat + NAV) / inbetalt', sortValue: (r) => r.tvpi, render: (r) => fmt.multiple(r.tvpi), footer: fmt.multiple(s.tvpi) },
    { key: 'irr', label: 'IRR', num: true, title: 'Netto-IRR i fondens valuta / i SEK', sortValue: (r) => r.irrBase, render: (r) => <div className="name-cell"><span className={tone(r.irr)}>{fmt.pct(r.irr)}</span><span className="sub">SEK {fmt.pct(r.irrBase)}</span></div>, footer: <span className={tone(s.irr)}>{fmt.pct(s.irr)}</span> },
  ];
  return (
    <DataTable rows={rows} columns={columns} rowKey={(r) => r.instrumentId} defaultSort={{ key: 'navsek', dir: -1 }} onRowClick={(r) => onOpen(r.instrumentId)}
      search={(r) => `${r.instrument.name} ${r.instrument.manager ?? ''} ${r.instrument.sub_class ?? ''}`} searchPlaceholder="Sök fond, förvaltare eller strategi" />
  );
}
