const nf = (min: number, max: number) => new Intl.NumberFormat('sv-SE', { minimumFractionDigits: min, maximumFractionDigits: max });
const n0 = nf(0, 0);
const n2 = nf(2, 2);
const pct1 = new Intl.NumberFormat('sv-SE', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct2 = new Intl.NumberFormat('sv-SE', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmt = {
  int: (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : n0.format(v)),
  dec: (v: number | null | undefined, d = 2) => (v == null || !isFinite(v) ? '–' : nf(d, d).format(v)),
  num: (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : Math.abs(v) >= 1000 ? n0.format(v) : n2.format(v)),
  qty: (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : nf(0, 4).format(v)),
  price: (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : nf(2, v < 10 ? 4 : 2).format(v)),
  sek: (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : n0.format(v) + ' kr'),
  /** Kompakt: 1,2 mdkr / 345,6 mkr */
  msek: (v: number | null | undefined) => {
    if (v == null || !isFinite(v)) return '–';
    const a = Math.abs(v);
    if (a >= 1e9) return nf(2, 2).format(v / 1e9) + ' mdkr';
    if (a >= 1e6) return nf(1, 1).format(v / 1e6) + ' mkr';
    if (a >= 1e3) return nf(0, 0).format(v / 1e3) + ' tkr';
    return n0.format(v) + ' kr';
  },
  pct: (v: number | null | undefined, d = 1) => (v == null || !isFinite(v) ? '–' : (d === 2 ? pct2 : pct1).format(v)),
  signedPct: (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : '') + pct1.format(v)),
  multiple: (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : nf(2, 2).format(v) + 'x'),
  date: (d: string | null | undefined) => d ?? '–',
};

export const tone = (v: number | null | undefined) => (v == null || Math.abs(v) < 1e-9 ? '' : v > 0 ? 'pos' : 'neg');

export const today = () => new Date().toISOString().slice(0, 10);
