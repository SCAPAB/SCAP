import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AllocationRow } from '../../../shared/types';
import { fmt } from '../format';

export function Kpi({ label, value, sub, tone, hero, title }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; hero?: boolean; title?: string }) {
  return (
    <div className={'kpi' + (hero ? ' hero' : '')} title={title}>
      <div className="label">{label}</div>
      <div className={'value ' + (tone ?? '')}>{value}</div>
      {sub != null && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Loading({ what = 'Laddar' }: { what?: string }) {
  return <div className="empty">{what} …</div>;
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="alert error">{error}</div> : null;
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { width: 'min(960px, 100%)' } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost small" onClick={onClose} aria-label="Stäng">✕</button>
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export interface Column<T> {
  key: string;
  label: ReactNode;
  num?: boolean;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => number | string | null;
  footer?: ReactNode;
  title?: string;
}

export function DataTable<T>({
  rows, columns, rowKey, search, searchPlaceholder = 'Sök', defaultSort, pageSize = 50, empty = 'Inga rader', onRowClick, toolbar,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string | number;
  search?: (r: T) => string;
  searchPlaceholder?: string;
  defaultSort?: { key: string; dir: 1 | -1 };
  pageSize?: number;
  empty?: string;
  onRowClick?: (r: T) => void;
  toolbar?: ReactNode;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(defaultSort ?? null);
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => {
    let r = rows;
    if (search && q.trim()) {
      const n = q.trim().toLowerCase();
      r = r.filter((x) => search(x).toLowerCase().includes(n));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.sortValue) {
        const sv = col.sortValue;
        r = [...r].sort((a, b) => {
          const va = sv(a);
          const vb = sv(b);
          if (va == null) return 1;
          if (vb == null) return -1;
          return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
        });
      }
    }
    return r;
  }, [rows, q, sort, columns, search]);
  useEffect(() => setPage(0), [q, rows]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const hasFooter = columns.some((c) => c.footer !== undefined);
  return (
    <div>
      {(search || toolbar) && (
        <div className="row" style={{ marginBottom: 12 }}>
          {search && <input type="search" placeholder={searchPlaceholder} value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} aria-label="Sök i tabellen" />}
          <div className="spacer" />
          {toolbar}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={(c.num ? 'num ' : '') + (c.sortValue ? 'sortable' : '')}
                  title={c.title}
                  onClick={() => c.sortValue && setSort((s) => ({ key: c.key, dir: s?.key === c.key ? ((-s.dir) as 1 | -1) : c.num ? -1 : 1 }))}
                  aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
                >
                  {c.label}
                  {sort?.key === c.key && <span className="arrow">{sort.dir === 1 ? '▲' : '▼'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} style={onRowClick ? { cursor: 'pointer' } : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : ''}>{c.render(r)}</td>
                ))}
              </tr>
            ))}
            {!visible.length && (
              <tr>
                <td colSpan={columns.length} className="empty">{empty}</td>
              </tr>
            )}
          </tbody>
          {hasFooter && visible.length > 0 && (
            <tfoot>
              <tr>
                {columns.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : ''}>{c.footer}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {filtered.length > pageSize && (
        <div className="pager">
          <span>{filtered.length} rader</span>
          <div className="row">
            <button className="btn small" disabled={page === 0} onClick={() => setPage(page - 1)}>Föregående</button>
            <span>Sida {page + 1} av {pages}</span>
            <button className="btn small" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Nästa</button>
          </div>
        </div>
      )}
    </div>
  );
}

export type Allocations = Record<string, { label: string; rows: AllocationRow[] }>;

/** Fördelning som horisontella staplar – lättare att jämföra än cirkeldiagram. */
export function AllocationCard({ allocations, initial = 'assetClass', title = 'Fördelning', exclude = [] }: { allocations: Allocations; initial?: string; title?: string; exclude?: string[] }) {
  const keys = Object.keys(allocations).filter((k) => !exclude.includes(k));
  const [dim, setDim] = useState(keys.includes(initial) ? initial : keys[0]);
  const rows = allocations[dim]?.rows ?? [];
  const max = Math.max(...rows.map((r) => r.share), 0.0001);
  const shown = rows.slice(0, 12);
  const rest = rows.slice(12);
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <select value={dim} onChange={(e) => setDim(e.target.value)} aria-label="Dimension">
          {keys.map((k) => <option key={k} value={k}>{allocations[k].label}</option>)}
        </select>
      </div>
      {!rows.length && <div className="empty">Inga innehav</div>}
      <div className="alloc">
        {shown.map((r) => (
          <div className="alloc-row" key={r.key}>
            <span>{r.key}</span>
            <span className="v">{fmt.msek(r.value)} · <strong>{fmt.pct(r.share)}</strong></span>
            <div className="bar"><span style={{ width: `${(r.share / max) * 100}%` }} /></div>
          </div>
        ))}
        {rest.length > 0 && (
          <div className="alloc-row">
            <span>Övriga ({rest.length})</span>
            <span className="v">{fmt.msek(rest.reduce((a, r) => a + r.value, 0))} · <strong>{fmt.pct(rest.reduce((a, r) => a + r.share, 0))}</strong></span>
          </div>
        )}
      </div>
    </div>
  );
}

export function EntityPicker({ entities, selected, onChange }: { entities: { id: number; name: string }[]; selected: number[] | null; onChange: (s: number[] | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const label = !selected ? 'Alla juridiska enheter' : selected.length === 1 ? entities.find((e) => e.id === selected[0])?.name ?? '1 enhet' : `${selected.length} enheter`;
  const toggle = (id: number) => {
    const cur = selected ?? entities.map((e) => e.id);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    onChange(next.length === entities.length ? null : next);
  };
  return (
    <div className="picker" ref={ref}>
      <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="muted small">Enheter:</span> {label} ▾
      </button>
      {open && (
        <div className="picker-pop">
          <label><input type="checkbox" checked={!selected} onChange={() => onChange(null)} /> <strong>Alla</strong></label>
          <div style={{ borderTop: '1px solid var(--line)', margin: '4px 0' }} />
          {entities.map((e) => (
            <label key={e.id}>
              <input type="checkbox" checked={!selected || selected.includes(e.id)} onChange={() => toggle(e.id)} />
              {e.name}
            </label>
          ))}
          {selected && selected.length === 0 && <div className="small muted" style={{ padding: 6 }}>Ingen enhet vald</div>}
        </div>
      )}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} aria-pressed={o.value === value}>{o.label}</button>
      ))}
    </div>
  );
}
