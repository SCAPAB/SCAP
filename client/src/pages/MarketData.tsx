import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApp, useFetch } from '../context';
import { DataTable, ErrorBox, Loading } from '../components/ui';
import { fmt, today } from '../format';
import MorningstarPanel from '../components/MorningstarPanel';
import type { Instrument } from '../../../shared/types';

type Ins = Instrument & { lastPrice: { date: string; value: number } | null };

export default function MarketData() {
  const [tab, setTab] = useState<'prices' | 'fx' | 'ms'>('prices');
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Kurser och valutor</h1>
          <p>Marknadsdata som används för värdering. NAV för PE-fonder registreras på respektive fond. Massuppdatering görs via <Link to="/import">Import</Link>.</p>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === 'prices' ? 'on' : ''} onClick={() => setTab('prices')}>Kurser</button>
        <button className={tab === 'fx' ? 'on' : ''} onClick={() => setTab('fx')}>Valutakurser</button>
        <button className={tab === 'ms' ? 'on' : ''} onClick={() => setTab('ms')}>Morningstar</button>
      </div>
      {tab === 'prices' ? <Prices /> : tab === 'fx' ? <Fx /> : <MorningstarPanel />}
    </div>
  );
}

function Prices() {
  const { canEdit, bump } = useApp();
  const { data, error } = useFetch<Ins[]>('/instruments');
  const [sel, setSel] = useState<number | null>(null);
  const [date, setDate] = useState(today());
  const [price, setPrice] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const hist = useFetch<{ date: string; price: number; source: string }[]>(sel ? `/prices?instrument=${sel}` : null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const listed = data.filter((i) => i.type !== 'PE_FUND');
  const stale = (d?: string) => !d || d < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const save = async () => {
    try {
      await api.post('/prices', { instrument_id: sel, date, price });
      setMsg({ ok: true, text: 'Kursen sparad' });
      setPrice('');
      bump();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const ins = listed.find((i) => i.id === sel);
  return (
    <div className="grid g-main">
      <div className="card">
        <DataTable
          rows={listed}
          rowKey={(r) => r.id}
          search={(r) => `${r.name} ${r.isin ?? ''}`}
          onRowClick={(r) => { setSel(r.id); setMsg(null); }}
          defaultSort={{ key: 'd', dir: 1 }}
          columns={[
            { key: 'n', label: 'Instrument', sortValue: (r) => r.name, render: (r) => <strong style={{ fontWeight: r.id === sel ? 650 : 400 }}>{r.name}</strong> },
            { key: 'c', label: 'Valuta', render: (r) => r.currency },
            { key: 'p', label: 'Senaste kurs', num: true, render: (r) => fmt.price(r.lastPrice?.value) },
            { key: 'd', label: 'Kursdatum', sortValue: (r) => r.lastPrice?.date ?? '', render: (r) => <span>{r.lastPrice?.date ?? '–'} {stale(r.lastPrice?.date) && <span className="badge warn">Inaktuell</span>}</span> },
          ]}
        />
      </div>
      <div className="card">
        {!ins ? <div className="empty">Välj ett instrument för att se historik och registrera kurs.</div> : (
          <>
            <h2>{ins.name}</h2>
            {canEdit && (
              <div className="row" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
                <label className="field">Datum<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
                <label className="field">Kurs ({ins.currency})<input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 110 }} /></label>
                <button className="btn primary" onClick={save} disabled={!price}>Spara</button>
              </div>
            )}
            {msg && <div className={'alert ' + (msg.ok ? 'ok' : 'error')}>{msg.text}</div>}
            {hist.data && (
              <DataTable
                rows={hist.data}
                rowKey={(r) => r.date}
                pageSize={15}
                columns={[
                  { key: 'd', label: 'Datum', render: (r) => r.date },
                  { key: 'p', label: 'Kurs', num: true, render: (r) => fmt.price(r.price) },
                  { key: 's', label: 'Källa', render: (r) => <span className="muted">{r.source}</span> },
                ]}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Fx() {
  const { canEdit, bump } = useApp();
  const { data, error } = useFetch<{ currency: string; date: string; rate: number }[]>('/fx');
  const [ccy, setCcy] = useState('');
  const [date, setDate] = useState(today());
  const [rate, setRate] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const save = async () => {
    try {
      await api.post('/fx', { currency: ccy, date, rate });
      setMsg({ ok: true, text: 'Valutakursen sparad' });
      setRate('');
      bump();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <div className="grid g-main">
      <div className="card">
        <h2>Senaste valutakurser (SEK per enhet)</h2>
        <DataTable
          rows={data}
          rowKey={(r) => r.currency}
          onRowClick={(r) => setCcy(r.currency)}
          columns={[
            { key: 'c', label: 'Valuta', render: (r) => <strong>{r.currency}</strong> },
            { key: 'r', label: 'Kurs', num: true, render: (r) => fmt.dec(r.rate, 4) },
            { key: 'd', label: 'Datum', render: (r) => r.date },
          ]}
        />
      </div>
      {canEdit && (
        <div className="card">
          <h2>Registrera valutakurs</h2>
          <div className="form-grid">
            <label className="field">Valuta<input value={ccy} onChange={(e) => setCcy(e.target.value.toUpperCase())} maxLength={3} /></label>
            <label className="field">Datum<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="field full">SEK per 1 {ccy || 'enhet'}<input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></label>
          </div>
          <div className="row mt"><button className="btn primary" onClick={save} disabled={!ccy || !rate}>Spara</button></div>
          {msg && <div className={'alert mt ' + (msg.ok ? 'ok' : 'error')}>{msg.text}</div>}
        </div>
      )}
    </div>
  );
}
