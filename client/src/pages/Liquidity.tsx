import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { useApp, useFetch } from '../context';
import { DataTable, ErrorBox, Kpi, Loading } from '../components/ui';
import { fmt } from '../format';
import { ASSET_CLASS_LABEL, type AssetClass } from '../../../shared/types';

interface Year { year: number; calls: number; distributions: number; nav: number; uncalled: number }
interface Fund { id: number; name: string; assetClass: AssetClass; subClass: string | null; vintage: number | null; currency: string; nav: number; uncalled: number; commitment: number; calledPct: number | null; forecast: Year[] }
interface Upcoming { id: number; trade_date: string; type: 'CALL' | 'DISTRIBUTION'; instrument: string; instrument_id: number; currency: string; amount: number; fee: number; sek: number; document_id: number | null }
interface Resp { asOf: string; uncalled: number; listedLiquid: number; coverage: number | null; upcoming: Upcoming[]; funds: Fund[]; totals: Year[]; note: string }

const ax = (v: number) => (Math.abs(v) >= 1e9 ? `${(v / 1e9).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} md` : `${(v / 1e6).toLocaleString('sv-SE', { maximumFractionDigits: 0 })} m`);

/** Likviditet och åtaganden: aviserade flöden och prognos för slutna fonder. */
export default function Liquidity() {
  const { scopeQs } = useApp();
  const { data, error } = useFetch<Resp>('/portfolio/liquidity' + scopeQs());
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const next12 = data.totals[0];
  const chart = data.totals.map((t) => ({ year: String(t.year), calls: -t.calls, distributions: t.distributions, net: t.distributions - t.calls }));
  const upcomingCalls = data.upcoming.filter((u) => u.type === 'CALL').reduce((a, u) => a + u.sek, 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Likviditet och åtaganden</h1>
          <p>Outnyttjade åtaganden i slutna fonder, aviserade kapitalanrop och en prognos över kommande kassaflöden per {data.asOf}.</p>
        </div>
      </div>
      <div className="kpis">
        <Kpi hero label="Outnyttjade åtaganden" value={fmt.msek(data.uncalled)} sub={`${data.funds.length} fonder`} />
        <Kpi label="Aviserade kapitalanrop" value={fmt.msek(upcomingCalls)} sub={`${data.upcoming.filter((u) => u.type === 'CALL').length} anrop med kommande likviddag`} />
        <Kpi label={`Prognos anrop ${next12?.year ?? ''}`} value={fmt.msek(next12?.calls)} sub={`Utdelningar ${fmt.msek(next12?.distributions)} · netto ${fmt.msek(next12 ? next12.distributions - next12.calls : null)}`} />
        <Kpi label="Täckningsgrad" value={data.coverage == null ? '–' : `${fmt.dec(data.coverage, 1)}x`} title="Likvida noterade tillgångar (exkl. absolute return) / outnyttjade åtaganden" sub="Likvida noterade tillgångar / outnyttjade åtaganden" tone={data.coverage != null && data.coverage < 1.5 ? 'neg' : ''} />
      </div>

      <div className="grid g-main">
        <div className="card">
          <div className="card-head"><h2>Prognos per år (SEK)</h2></div>
          <div className="legend" style={{ marginBottom: 6 }}>
            <span><i style={{ background: 'var(--series-1)' }} />Kapitalanrop</span>
            <span><i style={{ background: 'var(--series-3)' }} />Utdelningar</span>
            <span><i style={{ background: 'var(--series-2)', height: 2 }} />Nettoflöde</span>
          </div>
          <div style={{ height: 280 }}>
            <ResponsiveContainer>
              <ComposedChart data={chart} stackOffset="sign" margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="year" tickLine={false} axisLine={{ stroke: 'var(--line-strong)' }} />
                <YAxis tickFormatter={ax} width={56} tickLine={false} axisLine={false} />
                <ReferenceLine y={0} stroke="var(--line-strong)" />
                <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                  <div className="tooltip"><div className="t">{label}</div>
                    <div>Kapitalanrop: <strong>{fmt.msek(-Number(payload[0].payload.calls))}</strong></div>
                    <div>Utdelningar: <strong>{fmt.msek(Number(payload[0].payload.distributions))}</strong></div>
                    <div>Netto: <strong>{fmt.msek(Number(payload[0].payload.net))}</strong></div>
                  </div>) : null} />
                <Bar dataKey="calls" stackId="a" fill="var(--series-1)" radius={[0, 0, 4, 4]} maxBarSize={40} isAnimationActive={false} />
                <Bar dataKey="distributions" stackId="a" fill="var(--series-3)" radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
                <Line dataKey="net" stroke="var(--series-2)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="small muted">{data.note} Nya åtaganden ingår inte.</p>
        </div>
        <div className="card">
          <h2>Aviserade flöden</h2>
          {!data.upcoming.length && <div className="empty">Inga registrerade framtida anrop eller utdelningar</div>}
          <div className="stack" style={{ gap: 8 }}>
            {data.upcoming.map((u) => (
              <div key={u.id} className="upcoming">
                <div>
                  <strong>{u.trade_date}</strong> · {u.type === 'CALL' ? 'Kapitalanrop' : 'Utdelning'}
                  <div className="small"><Link to={`/instrument/${u.instrument_id}`}>{u.instrument}</Link>{u.document_id && <> · <Link to={`/inkorg/${u.document_id}`}>underlag</Link></>}</div>
                </div>
                <div className={'num ' + (u.type === 'CALL' ? 'neg' : 'pos')}>
                  {u.type === 'CALL' ? '−' : '+'}{fmt.int(u.amount + (u.type === 'CALL' ? u.fee : -u.fee))} {u.currency}
                  <div className="small muted">{fmt.msek(u.sek)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card mt">
        <div className="card-head"><h2>Per fond</h2></div>
        <DataTable
          rows={data.funds}
          rowKey={(f) => f.id}
          defaultSort={{ key: 'unc', dir: -1 }}
          columns={[
            { key: 'n', label: 'Fond', sortValue: (f) => f.name, render: (f) => <div className="name-cell"><Link to={`/instrument/${f.id}`}>{f.name}</Link><span className="sub">{ASSET_CLASS_LABEL[f.assetClass]} · {f.subClass} · vintage {f.vintage ?? '–'}</span></div> },
            { key: 'c', label: 'Åtagande SEK', num: true, sortValue: (f) => f.commitment, render: (f) => fmt.msek(f.commitment) },
            { key: 'p', label: 'Anropat', num: true, sortValue: (f) => f.calledPct, render: (f) => fmt.pct(f.calledPct) },
            { key: 'unc', label: 'Outnyttjat SEK', num: true, sortValue: (f) => f.uncalled, render: (f) => fmt.msek(f.uncalled) },
            { key: 'nav', label: 'NAV SEK', num: true, sortValue: (f) => f.nav, render: (f) => fmt.msek(f.nav) },
            ...data.totals.slice(0, 3).map((t, k) => ({
              key: `y${k}`, label: `Netto ${t.year}`, num: true, title: 'Prognos: utdelningar − kapitalanrop',
              sortValue: (f: Fund) => f.forecast[k].distributions - f.forecast[k].calls,
              render: (f: Fund) => { const v = f.forecast[k].distributions - f.forecast[k].calls; return <span className={v < 0 ? 'neg' : 'pos'}>{fmt.msek(v)}</span>; },
            })),
          ]}
        />
      </div>
    </div>
  );
}
