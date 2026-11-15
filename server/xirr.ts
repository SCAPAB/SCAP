import type { Cashflow } from '../shared/types.ts';

const DAY = 86_400_000;

/**
 * Internränta (XIRR) för oregelbundna kassaflöden, årlig takt.
 * Negativa belopp = utbetalningar från investeraren, positiva = inbetalningar/värde.
 * Returnerar null om den inte kan beräknas (t.ex. bara ett tecken på flödena).
 */
export function xirr(flows: Cashflow[]): number | null {
  const cf = flows.filter((f) => f.amount !== 0).sort((a, b) => a.date.localeCompare(b.date));
  if (cf.length < 2) return null;
  if (!cf.some((f) => f.amount < 0) || !cf.some((f) => f.amount > 0)) return null;
  const t0 = Date.parse(cf[0].date);
  const ts = cf.map((f) => (Date.parse(f.date) - t0) / DAY / 365);
  if (ts[ts.length - 1] <= 0) return null;

  const npv = (r: number) => cf.reduce((s, f, i) => s + f.amount / Math.pow(1 + r, ts[i]), 0);
  const dnpv = (r: number) => cf.reduce((s, f, i) => s - (ts[i] * f.amount) / Math.pow(1 + r, ts[i] + 1), 0);

  // Newton–Raphson
  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const v = npv(r);
    const d = dnpv(r);
    if (!isFinite(v) || !isFinite(d) || d === 0) break;
    const next = r - v / d;
    if (!isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }

  // Bisektion som reserv
  let lo = -0.9999;
  let hi = 10;
  let flo = npv(lo);
  const fhi = npv(hi);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-9 || hi - lo < 1e-12) return mid;
    if (flo * fm < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}
