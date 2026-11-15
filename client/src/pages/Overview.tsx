import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, useFetch } from '../context';
import { AllocationCard, ErrorBox, Kpi, Loading, Seg, type Allocations } from '../components/ui';
import { ValueChart } from '../components/charts';
import { fmt, tone } from '../format';
import { TYPE_LABELS, type InstrumentType, type PeriodReturn, type SeriesPoint } from '../../../shared/types';

interface OverviewData {
  asOf: string;
  totals: {
    marketValue: number; equities: number; funds: number; privateEquity: number; unrealized: number; uncalledCommitments: number;
    totalExposure: number; ytdChange: number; ytdNetFlows: number; ytdDividends: number; holdingsCount: number;
  };
  series: SeriesPoint[];
  returns: PeriodReturn[];
  top: { id: number; name: string; type: InstrumentType; value: number; weight: number }[];
  allocations: Allocations;
  staleData: { id: number; name: string; lastDate: string | null; kind: string }[];
}

export default function Overview() {
  const { scopeQs } = useApp();
  const { data, error, loading } = useFetch<OverviewData>('/portfolio/overview' + scopeQs());
  const [mode, setMode] = useState<'value' | 'index'>('value');
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const t = data.totals;
  const ytd = data.returns.find((r) => r.key === 'YTD')?.value ?? null;
  return (
    <div style={{ opacity: loading ? 0.6 : 1 }}>
      <div className="page-head">
        <div>
          <h1>Översikt</h1>
          <p>Portföljens värde per {data.asOf}, i SEK.</p>
        </div>
      </div>
      {data.staleData.length > 0 && (
        <div className="alert">
          <strong>Inaktuell värdering:</strong>{' '}
          {data.staleData.slice(0, 5).map((s, i) => (
            <span key={s.id}>{i > 0 && ', '}<Link to={`/instrument/${s.id}`}>{s.name}</Link> ({s.kind} {s.lastDate ?? 'saknas'})</span>
          ))}
          {data.staleData.length > 5 && ` och ${data.staleData.length - 5} till`}
        </div>
      )}
      <div className="kpis">
        <Kpi hero label="Marknadsvärde" value={fmt.msek(t.marketValue)} sub={`${t.holdingsCount} innehav`} />
        <Kpi label="Avkastning i år (TWR)" value={fmt.signedPct(ytd)} tone={tone(ytd)} sub={`Värdeförändring ${fmt.msek(t.ytdChange)}`} />
        <Kpi label="Orealiserat resultat" value={fmt.msek(t.unrealized)} tone={tone(t.unrealized)} sub="Noterat: direktägt och öppna fonder" />
        <Kpi label="Utdelningar i år" value={fmt.msek(t.ytdDividends)} sub={`Nettoinvesterat i år ${fmt.msek(t.ytdNetFlows)}`} />
        <Kpi label="Outnyttjade åtaganden" value={fmt.msek(t.uncalledCommitments)} sub={`Total exponering ${fmt.msek(t.totalExposure)}`} title="Kvarvarande åtaganden i PE-fonder som kan anropas" />
      </div>
      <div className="grid g-main">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Värdeutveckling</h2>
              <Seg value={mode} onChange={setMode} options={[{ value: 'value', label: 'Värde' }, { value: 'index', label: 'Avkastning' }]} />
            </div>
            {mode === 'value' && (
              <div className="legend" style={{ marginBottom: 6 }}>
                <span><i style={{ background: 'var(--series-1)' }} />Marknadsvärde</span>
                <span><i style={{ background: 'var(--series-2)', height: 2 }} />Nettoinvesterat kapital</span>
              </div>
            )}
            <ValueChart series={data.series} mode={mode} />
            <div className="returns">
              {data.returns.map((r) => (
                <div key={r.key} title={`Från ${r.from}`}>
                  <div className="l">{r.label}</div>
                  <div className={'v ' + tone(r.value)}>{fmt.signedPct(r.value)}</div>
                </div>
              ))}
            </div>
            <div className="small muted" style={{ marginTop: 8 }}>Tidsviktad avkastning (TWR) i SEK, inklusive utdelningar och efter avgifter. Perioderna bryts vid varje kassaflöde.</div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Största innehav</h2></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Instrument</th><th>Typ</th><th className="num">Marknadsvärde</th><th className="num">Andel</th></tr></thead>
                <tbody>
                  {data.top.map((h) => (
                    <tr key={h.id}>
                      <td><Link to={`/instrument/${h.id}`}>{h.name}</Link></td>
                      <td><span className="badge">{TYPE_LABELS[h.type]}</span></td>
                      <td className="num">{fmt.sek(h.value)}</td>
                      <td className="num">{fmt.pct(h.weight)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="stack">
          <PolicyCard />
          <AllocationCard allocations={data.allocations} initial="currency" title="Fördelning" exclude={['assetClass']} />
        </div>
      </div>
    </div>
  );
}

/** Kompakt bild av allokeringen mot policyportföljen. */
function PolicyCard() {
  const { scopeQs } = useApp();
  const { data } = useFetch<{ total: number; rows: { key: string; label: string; path: string; value: number; share: number; target: number | null; min: number | null; max: number | null; status: string }[] }>('/portfolio/allocation' + scopeQs());
  if (!data) return <div className="card"><Loading /></div>;
  return (
    <div className="card">
      <div className="card-head"><h2>Tillgångsslag mot policy</h2><Link to="/allokering" className="small">Detaljer →</Link></div>
      <table className="policy-mini">
        <thead><tr><th /><th className="num">Värde</th><th className="num">Vikt</th><th className="num">Mål</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.key}>
              <td><Link to={`/tillgangsslag/${r.path}`}>{r.label}</Link></td>
              <td className="num">{fmt.msek(r.value)}</td>
              <td className={'num ' + (r.status === 'ok' ? '' : 'neg')} title={r.status === 'ok' ? 'Inom intervall' : 'Utanför tillåtet intervall'}>
                {fmt.pct(r.share)}{r.status !== 'ok' && r.status !== 'none' && ' !'}
              </td>
              <td className="num muted">{r.target == null ? '–' : fmt.pct(r.target, 0)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td>Totalt</td><td className="num">{fmt.msek(data.total)}</td><td className="num">100 %</td><td /></tr></tfoot>
      </table>
    </div>
  );
}
