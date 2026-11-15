import { useState } from 'react';
import { useApp } from '../context';
import { today } from '../format';

export default function Reports() {
  const { scope, asOf } = useApp();
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const q = (o: Record<string, string | null | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
    return p.toString();
  };
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Rapporter</h1>
          <p>Exportera till CSV (öppnas direkt i Excel).</p>
        </div>
      </div>
      <div className="grid g-2">
        <div className="card">
          <h2>Innehavsrapport</h2>
          <p className="small muted">Alla innehav per {asOf} med antal, GAV, kurs, anskaffnings- och marknadsvärde, orealiserat/realiserat resultat samt PE-nyckeltal (åtagande, inbetalt, NAV, DPI, TVPI, IRR). Byt datum uppe till höger för historisk rapport.</p>
          <a className="btn primary" href={`/api/reports/holdings.csv?${q({ entities: scope.entities, asOf })}`}>Ladda ner innehavsrapport</a>
        </div>
        <div className="card">
          <h2>Transaktionsrapport</h2>
          <p className="small muted">Alla transaktioner i perioden, med belopp i lokal valuta och SEK.</p>
          <div className="row" style={{ margin: '10px 0' }}>
            <label className="field">Från<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="field">Till<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          <a className="btn primary" href={`/api/reports/transactions.csv?${q({ entities: scope.entities, from, to })}`}>Ladda ner transaktionsrapport</a>
        </div>
        <div className="card">
          <h2>Utskrift / PDF</h2>
          <p className="small muted">Alla vyer (översikt, aktier, fonder, PE-fonder) är anpassade för utskrift. Öppna vyn och välj Skriv ut → Spara som PDF.</p>
          <button className="btn" onClick={() => window.print()}>Skriv ut denna sida</button>
        </div>
      </div>
    </div>
  );
}
