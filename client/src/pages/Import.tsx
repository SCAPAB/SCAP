import { useState } from 'react';
import { api } from '../api';
import { useApp, useFetch } from '../context';
import { ErrorBox, Loading } from '../components/ui';

interface Kind { label: string; columns: string[]; example: string }
interface Result { kind: string; rows: number; inserted: number; errors: { row: number; message: string }[]; preview: Record<string, unknown>[]; committed: boolean }

export default function ImportPage() {
  const { canEdit, bump } = useApp();
  const { data: kinds } = useFetch<Record<string, Kind>>('/import-kinds');
  const [kind, setKind] = useState('transactions');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!kinds) return <Loading />;
  if (!canEdit) return <div className="alert">Du har läsbehörighet och kan inte importera data.</div>;
  const k = kinds[kind];

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<Result>(`/import/${kind}`, { csv, dryRun });
      setResult(r);
      if (r.committed) bump();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const buf = await f.arrayBuffer();
    // Försök UTF-8, fall tillbaka på Windows-1252 (vanligt vid export från svenskt Excel)
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
    setCsv(text);
    setResult(null);
  };
  const headers = result?.preview[0] ? Object.keys(result.preview[0]) : [];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Import</h1>
          <p>Läs in data från CSV (semikolon eller komma, decimalkomma fungerar). Testa först – inget sparas förrän du bekräftar, och filen sparas bara om alla rader är korrekta.</p>
        </div>
      </div>
      <div className="grid g-main">
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <label className="field">Vad ska importeras?
              <select value={kind} onChange={(e) => { setKind(e.target.value); setResult(null); }}>
                {Object.entries(kinds).map(([key, v]) => <option key={key} value={key}>{v.label}</option>)}
              </select>
            </label>
            <label className="field">Fil<input type="file" accept=".csv,.txt,text/csv" onChange={(e) => onFile(e.target.files?.[0])} /></label>
          </div>
          <label className="field">Innehåll (eller klistra in direkt från Excel)
            <textarea rows={12} value={csv} onChange={(e) => { setCsv(e.target.value.replace(/\t/g, ';')); setResult(null); }} placeholder={k.example} />
          </label>
          <div className="row mt">
            <button className="btn" onClick={() => run(true)} disabled={!csv.trim() || busy}>Testa import</button>
            <button className="btn primary" onClick={() => run(false)} disabled={!result || result.errors.length > 0 || result.committed || busy}>
              Spara {result && !result.committed && !result.errors.length ? `${result.inserted} rader` : ''}
            </button>
          </div>
          <ErrorBox error={error} />
          {result && (
            <div className="mt">
              {result.committed && <div className="alert ok">{result.inserted} rader sparades.</div>}
              {!result.committed && !result.errors.length && <div className="alert ok">Alla {result.rows} rader är giltiga. Klicka på Spara för att läsa in dem.</div>}
              {result.errors.length > 0 && (
                <div className="alert error">
                  <strong>{result.errors.length} fel – inget sparades.</strong>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {result.errors.slice(0, 30).map((e, i) => <li key={i}>Rad {e.row}: {e.message}</li>)}
                  </ul>
                </div>
              )}
              {result.preview.length > 0 && (
                <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                  <table>
                    <thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                    <tbody>{result.preview.map((r, i) => <tr key={i}>{headers.map((h) => <td key={h}>{String(r[h] ?? '')}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="card">
          <h2>Format – {k.label.toLowerCase()}</h2>
          <p className="small">Kolumner (första raden ska vara rubriker):</p>
          <div className="row" style={{ marginBottom: 12 }}>{k.columns.map((c) => <span key={c} className="badge">{c}</span>)}</div>
          <p className="small">Exempel:</p>
          <pre className="small" style={{ background: 'var(--surface-2)', padding: 10, borderRadius: 8, overflowX: 'auto' }}>{k.example}</pre>
          <button className="btn small" onClick={() => { setCsv(k.example); setResult(null); }}>Använd exemplet</button>
          <ul className="small muted" style={{ paddingLeft: 18, marginTop: 14 }}>
            <li>Datum anges ÅÅÅÅ-MM-DD.</li>
            <li>Enhet: namn, org.nr eller id. Instrument: ISIN, namn, ticker eller id.</li>
            {kind === 'transactions' && <li>Typ: Köp, Sälj, Utdelning, Avgift, Åtagande, Kapitalanrop, Återbetalning.</li>}
            {kind === 'transactions' && <li>Lämnas valutakurs tom hämtas den från registrerade valutakurser.</li>}
            <li>Befintliga kurser/NAV för samma datum skrivs över.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

