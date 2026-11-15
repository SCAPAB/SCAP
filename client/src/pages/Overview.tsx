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
        <Kpi label="Orealiserat resultat" value={fmt.msek(t.unrealized)} tone={tone(t.unrealized)} sub="Aktier och fonder" />
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
            <div className="small muted" style={{ marginTop: 8 }}>Tidsviktad avkastning (länkad Modified Dietz, veckovis) inklusive utdelningar, efter avgifter, i SEK.</div>
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
          <div className="card">
            <h2>Tillgångsslag</h2>
            <dl className="facts">
              <dt><Link to="/aktier">Direktägda aktier</Link></dt><dd>{fmt.msek(t.equities)}</dd>
              <dt><Link to="/fonder">Fonder</Link></dt><dd>{fmt.msek(t.funds)}</dd>
              <dt><Link to="/pe">Private equity (NAV)</Link></dt><dd>{fmt.msek(t.privateEquity)}</dd>
              <div className="sep" />
              <dt><strong>Totalt</strong></dt><dd>{fmt.msek(t.marketValue)}</dd>
              <dt>Outnyttjade åtaganden</dt><dd>{fmt.msek(t.uncalledCommitments)}</dd>
            </dl>
          </div>
          <AllocationCard allocations={data.allocations} initial="assetClass" />
          <AllocationCard allocations={data.allocations} initial="currency" title="Fördelning – alternativ vy" />
        </div>
      </div>
    </div>
  );
}
