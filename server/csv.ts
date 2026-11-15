/** Enkel CSV-skrivare med semikolon (öppnas direkt i svenskt Excel). */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Decimalpunkt → decimalkomma för numeriska fält
  const cell = (v: unknown) => (typeof v === 'string' && /^-?\d+\.\d+$/.test(v) ? v.replace('.', ',') : v);
  return [headers.map(esc).join(';'), ...rows.map((r) => headers.map((h) => esc(cell(r[h]))).join(';'))].join('\r\n');
}
