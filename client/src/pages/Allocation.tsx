import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApp, useFetch } from '../context';
import { ErrorBox, Kpi, Loading, Modal } from '../components/ui';
import { fmt } from '../format';

interface Row {
  key: string; label: string; path: string; value: number; share: number; uncalled: number; exposureShare: number;
  target: number | null; min: number | null; max: number | null; deviation: number | null; status: 'ok' | 'under' | 'over' | 'none'; rebalance: number | null;
  subs: { key: string; value: number; share: number }[];
}
interface Resp { asOf: string; total: number; totalExposure: number; rows: Row[] }

const STATUS = { ok: { t: 'Inom intervall', c: 'ok' }, under: { t: 'Under intervall', c: 'err' }, over: { t: 'Över intervall', c: 'err' }, none: { t: 'Ingen policy', c: '' } };

/** Faktisk allokering mot policyportföljen (strategisk allokering). */
export default function Allocation() {
  const { scopeQs, isAdmin } = useApp();
  const [tick, setTick] = useState(0);
  const { data, error } = useFetch<Resp>('/portfolio/allocation' + scopeQs(), [tick]);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const outside = data.rows.filter((r) => r.status === 'under' || r.status === 'over');
  const scaleMax = Math.max(0.6, ...data.rows.map((r) => Math.max(r.share, r.max ?? 0, r.exposureShare))) * 1.05;
  const pos = (v: number) => `${(v / scaleMax) * 100}%`;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Allokering mot policy</h1>
          <p>Faktisk fördelning per tillgångsslag per {data.asOf} jämfört med policyportföljens målvikter och tillåtna intervall.</p>
        </div>
        {isAdmin && <button className="btn" onClick={() => setEdit(true)}>Ändra policyportfölj</button>}
      </div>
      <div className="kpis">
        <Kpi hero label="Marknadsvärde" value={fmt.msek(data.total)} />
        <Kpi label="Exponering inkl. outnyttjade åtaganden" value={fmt.msek(data.totalExposure)} sub={`Åtaganden ${fmt.msek(data.totalExposure - data.total)}`} />
        <Kpi label="Utanför intervall" value={String(outside.length)} tone={outside.length ? 'neg' : 'pos'} sub={outside.length ? outside.map((r) => r.label).join(', ') : 'Alla tillgångsslag inom intervall'} />
      </div>
      <div className="card">
        <div className="legend" style={{ marginBottom: 10 }}>
          <span><i style={{ background: 'var(--series-1)' }} />Faktisk vikt</span>
          <span><i style={{ background: 'color-mix(in srgb, var(--series-1) 30%, transparent)' }} />Inkl. outnyttjade åtaganden</span>
          <span><i style={{ background: 'var(--surface-2)', outline: '1px solid var(--line-strong)' }} />Tillåtet intervall</span>
          <span><i style={{ background: 'var(--ink)', width: 2 }} />Målvikt</span>
        </div>
        <div className="table-wrap">
          <table className="alloc-table">
            <thead>
              <tr>
                <th>Tillgångsslag</th><th className="num">Marknadsvärde</th><th className="num">Vikt</th><th className="num">Mål</th><th className="num">Intervall</th>
                <th className="num">Avvikelse</th><th style={{ width: '28%' }}>Mot policy</th><th>Status</th><th className="num" title="Belopp som behöver köpas (+) eller säljas (−) för att nå målvikten">Till målvikt</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <Fragment key={r.key}>
                  <tr onClick={() => setOpen(open === r.key ? null : r.key)} style={{ cursor: 'pointer' }}>
                    <td><span className="muted small">{open === r.key ? '▾' : '▸'}</span> <Link to={`/tillgangsslag/${r.path}`} onClick={(e) => e.stopPropagation()}>{r.label}</Link></td>
                    <td className="num">{fmt.msek(r.value)}</td>
                    <td className="num"><strong>{fmt.pct(r.share)}</strong></td>
                    <td className="num">{r.target == null ? '–' : fmt.pct(r.target, 1)}</td>
                    <td className="num muted">{r.min == null ? '–' : `${fmt.pct(r.min, 0)}–${fmt.pct(r.max, 0)}`}</td>
                    <td className={'num ' + (r.status === 'ok' ? '' : 'neg')}>{r.deviation == null ? '–' : `${r.deviation > 0 ? '+' : ''}${fmt.dec(r.deviation * 100, 1)} pe`}</td>
                    <td>
                      <div className="policy-bar" title={`Vikt ${fmt.pct(r.share)} · inkl. åtaganden ${fmt.pct(r.exposureShare)}`}>
                        {r.min != null && <span className="band" style={{ left: pos(r.min), width: `calc(${pos(r.max! - r.min)})` }} />}
                        {r.exposureShare > r.share && <span className="exp" style={{ width: pos(r.exposureShare) }} />}
                        <span className="act" style={{ width: pos(r.share) }} />
                        {r.target != null && <span className="tgt" style={{ left: pos(r.target) }} />}
                      </div>
                    </td>
                    <td><span className={'badge ' + STATUS[r.status].c}>{STATUS[r.status].t}</span></td>
                    <td className="num">{r.rebalance == null ? '–' : `${r.rebalance > 0 ? '+' : ''}${fmt.msek(r.rebalance)}`}</td>
                  </tr>
                  {open === r.key && r.subs.map((s) => (
                    <tr key={s.key} className="subrow">
                      <td style={{ paddingLeft: 30 }}>{s.key}</td>
                      <td className="num">{fmt.msek(s.value)}</td>
                      <td className="num muted">{fmt.pct(s.value / data.total)}</td>
                      <td colSpan={6} className="muted small">{fmt.pct(s.share)} av {r.label.toLowerCase()}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr><td>Totalt</td><td className="num">{fmt.msek(data.total)}</td><td className="num">100 %</td><td className="num">{fmt.pct(data.rows.reduce((a, r) => a + (r.target ?? 0), 0), 0)}</td><td colSpan={5} /></tr>
            </tfoot>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          Vikter beräknas på marknadsvärde (för slutna fonder: senaste NAV, framräknat). Likvida medel ingår inte. Den ljusare stapeln visar exponeringen om alla outnyttjade åtaganden anropas – relevant för planering av nya åtaganden.
        </p>
      </div>
      {edit && <PolicyEditor rows={data.rows} onClose={() => setEdit(false)} onSaved={() => setTick((x) => x + 1)} />}
    </div>
  );
}

function PolicyEditor({ rows, onClose, onSaved }: { rows: Row[]; onClose: () => void; onSaved: () => void }) {
  const [vals, setVals] = useState(() => rows.map((r) => ({ asset_class: r.key, label: r.label, target: String(((r.target ?? 0) * 100).toFixed(1)), min: String(((r.min ?? 0) * 100).toFixed(1)), max: String(((r.max ?? 0) * 100).toFixed(1)) })));
  const [err, setErr] = useState<string | null>(null);
  const sum = vals.reduce((a, v) => a + (Number(v.target.replace(',', '.')) || 0), 0);
  const save = async () => {
    try {
      const p = (s: string) => (Number(s.replace(',', '.')) || 0) / 100;
      await api.put('/policy-targets', { rows: vals.map((v) => ({ asset_class: v.asset_class, target: p(v.target), min: p(v.min), max: p(v.max) })) });
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const set = (i: number, k: 'target' | 'min' | 'max', v: string) => setVals((x) => x.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Modal title="Policyportfölj" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Avbryt</button><button className="btn primary" onClick={save}>Spara</button></>}>
      <p className="small muted">Målvikt och tillåtet intervall per tillgångsslag (%), enligt placeringspolicyn. Målvikterna ska summera till 100 %.</p>
      <table>
        <thead><tr><th>Tillgångsslag</th><th className="num">Min</th><th className="num">Mål</th><th className="num">Max</th></tr></thead>
        <tbody>
          {vals.map((v, i) => (
            <tr key={v.asset_class}>
              <td>{v.label}</td>
              {(['min', 'target', 'max'] as const).map((k) => (
                <td key={k} className="num"><input value={v[k]} onChange={(e) => set(i, k, e.target.value)} style={{ width: 70, textAlign: 'right' }} inputMode="decimal" /></td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td>Summa mål</td><td /><td className={'num ' + (Math.abs(sum - 100) > 0.01 ? 'neg' : 'pos')}>{fmt.dec(sum, 1)} %</td><td /></tr></tfoot>
      </table>
      {err && <div className="alert error mt">{err}</div>}
    </Modal>
  );
}
