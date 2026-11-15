import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { useApp, useFetch } from '../context';
import { ErrorBox, Loading } from '../components/ui';
import { fmt, tone } from '../format';
import { ASSET_CLASSES, type PeriodReturn } from '../../../shared/types';

interface Row { key: string; label: string; value: number; returns: PeriodReturn[]; irr: number | null; hasPrivate: boolean; series: { date: string; index: number }[] }
interface Resp { asOf: string; total: Row; rows: Row[] }

// Fast färg per tillgångsslag (följer entiteten, inte rangordningen)
const COLORS: Record<string, string> = {
  TOTAL: 'var(--ink)', PUBLIC_EQUITY: 'var(--series-1)', FIXED_INCOME: 'var(--series-2)', PRIVATE_EQUITY: 'var(--series-3)', REAL_ASSETS: 'var(--series-4)', ABSOLUTE_RETURN: 'var(--series-5)',
};

export default function Performance() {
  const { scopeQs } = useApp();
  const { data, error } = useFetch<Resp>('/portfolio/performance' + scopeQs());
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const all = [data.total, ...data.rows];
  const periods = data.total.returns;
  // Sammanfoga serierna på datum för diagrammet
  const byDate = new Map<string, Record<string, number | string>>();
  for (const r of all) for (const p of r.series) {
    const o = byDate.get(p.date) ?? { date: p.date };
    if (p.index != null && isFinite(p.index)) o[r.key] = p.index / 100 - 1;
    byDate.set(p.date, o);
  }
  const chart = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const path = (k: string) => ASSET_CLASSES.find((a) => a.key === k)?.path;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Avkastning</h1>
          <p>Tidsviktad avkastning (TWR) i SEK per tillgångsslag per {data.asOf}, efter avgifter och inklusive utdelningar. För slutna fonder visas även netto-IRR sedan start.</p>
        </div>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tillgångsslag</th><th className="num">Marknadsvärde</th>
                {periods.map((p) => <th key={p.key} className="num" title={`Från ${p.from}`}>{p.label}</th>)}
                <th className="num" title="Netto-IRR i SEK för slutna fonder, sedan första kassaflöde">IRR sedan start</th>
              </tr>
            </thead>
            <tbody>
              {all.map((r) => (
                <tr key={r.key} className={r.key === 'TOTAL' ? 'total-row' : ''}>
                  <td>
                    <span className="swatch" style={{ background: COLORS[r.key] }} />
                    {r.key === 'TOTAL' ? <strong>{r.label}</strong> : <Link to={`/tillgangsslag/${path(r.key)}`}>{r.label}</Link>}
                  </td>
                  <td className="num">{fmt.msek(r.value)}</td>
                  {r.returns.map((p) => <td key={p.key} className={'num ' + tone(p.value)}>{fmt.signedPct(p.value)}</td>)}
                  <td className="num">{r.hasPrivate ? <span className={tone(r.irr)}>{fmt.pct(r.irr)}</span> : <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          TWR för slutna fonder bygger på kvartalsvisa NAV-rapporter som rullas fram med kassaflöden, och släpar därför normalt ett kvartal. Jämför private markets över tid med IRR och TVPI snarare än korta TWR-perioder.
        </p>
      </div>
      <div className="card">
        <div className="card-head"><h2>Ackumulerad avkastning</h2></div>
        <div className="legend" style={{ marginBottom: 6 }}>
          {all.map((r) => <span key={r.key}><i style={{ background: COLORS[r.key] }} />{r.label}</span>)}
        </div>
        <div style={{ height: 320 }}>
          <ResponsiveContainer>
            <LineChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" minTickGap={50} tickLine={false} axisLine={{ stroke: 'var(--line-strong)' }} tickFormatter={(d: string) => d.slice(0, 7)} />
              <YAxis tickFormatter={(v) => fmt.pct(v, 1)} width={60} tickLine={false} axisLine={false} />
              <ReferenceLine y={0} stroke="var(--line-strong)" />
              <Tooltip
                content={({ active, payload, label }) => active && payload?.length ? (
                  <div className="tooltip">
                    <div className="t">{label}</div>
                    {payload.map((p) => <div key={String(p.dataKey)}><span className="swatch" style={{ background: COLORS[String(p.dataKey)] }} />{all.find((r) => r.key === p.dataKey)?.label}: <strong>{fmt.signedPct(Number(p.value))}</strong></div>)}
                  </div>
                ) : null}
              />
              {all.map((r) => <Line key={r.key} dataKey={r.key} stroke={COLORS[r.key]} strokeWidth={r.key === 'TOTAL' ? 2.25 : 1.5} dot={false} isAnimationActive={false} connectNulls />)}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
