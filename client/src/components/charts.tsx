import { Area, AreaChart, Bar, CartesianGrid, ComposedChart, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SeriesPoint } from '../../../shared/types';
import { fmt } from '../format';

const axisNum = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toLocaleString('sv-SE', { maximumFractionDigits: 1 }) + ' md';
  if (a >= 1e6) return (v / 1e6).toLocaleString('sv-SE', { maximumFractionDigits: 0 }) + ' m';
  return v.toLocaleString('sv-SE', { maximumFractionDigits: 2 });
};
const monthTick = (d: string) => {
  const [y, m] = d.split('-');
  return `${['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'][Number(m) - 1]} ${y.slice(2)}`;
};

type Mode = 'value' | 'index';

/** Värdeutveckling: marknadsvärde mot nettoinvesterat, eller tidsviktad avkastning (index). */
export function ValueChart({ series, mode }: { series: SeriesPoint[]; mode: Mode }) {
  if (!series.length) return <div className="empty">Ingen historik</div>;
  const data = series.map((p) => ({ ...p, ret: p.index / 100 - 1 }));
  return (
    <div className="chart" style={{ height: 300 }}>
      <ResponsiveContainer>
        {mode === 'value' ? (
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="vfill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.22} />
                <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickFormatter={monthTick} minTickGap={40} tickLine={false} axisLine={{ stroke: 'var(--line-strong)' }} />
            <YAxis tickFormatter={axisNum} width={56} tickLine={false} axisLine={false} domain={['auto', 'auto']} />
            <Tooltip content={<Tip rows={[{ k: 'value', l: 'Marknadsvärde', f: fmt.msek }, { k: 'netInvested', l: 'Nettoinvesterat', f: fmt.msek }]} />} />
            <Area type="monotone" dataKey="value" stroke="var(--series-1)" strokeWidth={2} fill="url(#vfill)" dot={false} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="netInvested" stroke="var(--series-2)" strokeWidth={2} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
          </AreaChart>
        ) : (
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickFormatter={monthTick} minTickGap={40} tickLine={false} axisLine={{ stroke: 'var(--line-strong)' }} />
            <YAxis tickFormatter={(v) => fmt.pct(v, 1)} width={56} tickLine={false} axisLine={false} />
            <ReferenceLine y={0} stroke="var(--line-strong)" />
            <Tooltip content={<Tip rows={[{ k: 'ret', l: 'Avkastning (TWR)', f: (v) => fmt.signedPct(v) }]} />} />
            <Line type="monotone" dataKey="ret" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

export function PriceChart({ data, currency }: { data: { date: string; price: number }[]; currency: string }) {
  if (!data.length) return <div className="empty">Ingen kurshistorik</div>;
  return (
    <div className="chart" style={{ height: 240 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="date" tickFormatter={monthTick} minTickGap={40} tickLine={false} axisLine={{ stroke: 'var(--line-strong)' }} />
          <YAxis tickFormatter={axisNum} width={56} tickLine={false} axisLine={false} domain={['auto', 'auto']} />
          <Tooltip content={<Tip rows={[{ k: 'price', l: `Kurs (${currency})`, f: fmt.price }]} />} />
          <Line type="monotone" dataKey="price" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** PE-kassaflöden per år: anrop (negativa) och utdelningar (positiva) samt ackumulerat nettoflöde (J-kurva). */
export function CashflowChart({ data }: { data: { year: string; calls: number; distributions: number; cumulative: number }[] }) {
  if (!data.length) return <div className="empty">Inga kassaflöden</div>;
  return (
    <>
      <div className="legend" style={{ marginBottom: 6 }}>
        <span><i style={{ background: 'var(--series-1)' }} />Kapitalanrop</span>
        <span><i style={{ background: 'var(--series-3)' }} />Utdelningar</span>
        <span><i style={{ background: 'var(--series-2)', height: 2 }} />Ackumulerat netto</span>
      </div>
      <div className="chart" style={{ height: 260 }}>
        <ResponsiveContainer>
          <ComposedChart data={data} stackOffset="sign" margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="year" tickLine={false} axisLine={{ stroke: 'var(--line-strong)' }} />
            <YAxis tickFormatter={axisNum} width={56} tickLine={false} axisLine={false} />
            <ReferenceLine y={0} stroke="var(--line-strong)" />
            <Tooltip content={<Tip label="year" rows={[{ k: 'calls', l: 'Kapitalanrop', f: fmt.msek }, { k: 'distributions', l: 'Utdelningar', f: fmt.msek }, { k: 'cumulative', l: 'Ackumulerat netto', f: fmt.msek }]} />} />
            <Bar dataKey="calls" stackId="a" fill="var(--series-1)" radius={[0, 0, 4, 4]} isAnimationActive={false} maxBarSize={36} />
            <Bar dataKey="distributions" stackId="a" fill="var(--series-3)" radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={36} />
            <Line type="monotone" dataKey="cumulative" stroke="var(--series-2)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

interface TipProps {
  active?: boolean;
  payload?: { payload: Record<string, number | string> }[];
  rows: { k: string; l: string; f: (v: number) => string }[];
  label?: string;
}
function Tip({ active, payload, rows, label = 'date' }: TipProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="tooltip">
      <div className="t">{String(p[label])}</div>
      {rows.map((r) => (
        <div key={r.k}>
          {r.l}: <strong>{r.f(Number(p[r.k]))}</strong>
        </div>
      ))}
    </div>
  );
}
