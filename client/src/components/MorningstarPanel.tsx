import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApp, useFetch } from '../context';
import { DataTable, ErrorBox, Loading } from './ui';
import { fmt, today } from '../format';
import { TYPE_LABELS, type InstrumentType } from '../../../shared/types';

interface Status {
  token: { set: boolean; expiresAt?: string | null; expired?: boolean; setBy?: string | null; setAt?: string };
  instruments: { id: number; name: string; isin: string | null; type: InstrumentType; currency: string; ms_secid: string | null; ms_listing: string | null; last_date: string | null; last_source: string | null }[];
  log: { id: number; ts: string; kind: string; ok: number; summary: string; user_name: string | null }[];
}
interface Cand { sec_id: string; label: string; name: string | null; currency: string | null; exchange: string | null; score: number }
interface LookupRow { instrument_id: number; name: string; isin: string; currency?: string; candidates: Cand[]; suggested: Cand | null; clear: boolean; error?: string }
interface SyncResult { from: string; to: string; total: number; instruments: { name: string; inserted: number; updated: number; skippedManual: number; last: { date: string; price: number } | null; jump: number | null }[]; missing: string[] }

const localTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : '–');

/** Morningstar via Analytics Lab: nyckel, koppling av instrument och hämtning av kurser. */
export default function MorningstarPanel() {
  const { canEdit, bump } = useApp();
  const [tick, setTick] = useState(0);
  const { data, error } = useFetch<Status>('/morningstar/status', [tick]);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lookup, setLookup] = useState<LookupRow[] | null>(null);
  const [choice, setChoice] = useState<Record<number, string>>({});
  const [from, setFrom] = useState('');
  const [sync, setSync] = useState<SyncResult | null>(null);
  const reload = () => setTick((x) => x + 1);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const t = data.token;
  const usable = t.set && !t.expired;
  const mapped = data.instruments.filter((i) => i.ms_secid);
  const unmapped = data.instruments.filter((i) => !i.ms_secid);

  const confirm = async (row: LookupRow, secId: string) => {
    const c = row.candidates.find((x) => x.sec_id === secId)!;
    await api.put(`/instruments/${row.instrument_id}/morningstar`, { sec_id: c.sec_id, listing: c.label });
    setLookup((l) => l?.filter((x) => x.instrument_id !== row.instrument_id) ?? null);
    reload();
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>Anslutning – Morningstar Analytics Lab</h2></div>
        <div className="grid g-2">
          <div>
            <dl className="facts">
              <dt>Status</dt>
              <dd>{!t.set ? <span className="badge">Ingen nyckel</span> : t.expired ? <span className="badge err">Nyckeln har gått ut</span> : <span className="badge ok">Ansluten</span>}</dd>
              {t.set && <><dt>Giltig till</dt><dd>{localTime(t.expiresAt)}</dd><dt>Inlagd av</dt><dd>{t.setBy ?? '–'} {localTime(t.setAt)}</dd></>}
              <dt>Kopplade instrument</dt><dd>{mapped.length} av {data.instruments.length}</dd>
            </dl>
            <p className="small muted" style={{ marginTop: 12 }}>
              Nyckeln sparas bara i serverns minne och försvinner vid omstart. Den skrivs aldrig till databasen eller loggen.
              För helt automatisk hämtning varje natt behövs en långlivad API-nyckel från Morningstar.
            </p>
          </div>
          {canEdit && (
            <div>
              <ol className="small" style={{ margin: '0 0 10px', paddingLeft: 18, color: 'var(--ink-2)' }}>
                <li>Öppna <a href="https://analyticslab.morningstar.com/" target="_blank" rel="noreferrer">Analytics Lab</a> och logga in.</li>
                <li>Välj menyn <strong>Analytics Lab → Copy Authentication Token</strong>.</li>
                <li>Klistra in nyckeln här och spara.</li>
              </ol>
              <label className="field full">Nyckel från Analytics Lab
                <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" />
              </label>
              <div className="row mt">
                <button className="btn primary" disabled={!token || !!busy} onClick={() => act('token', async () => { const r = await api.post<{ expiresAt: string | null }>('/morningstar/token', { token }); setToken(''); setMsg({ ok: true, text: `Nyckeln är sparad, giltig till ${localTime(r.expiresAt)}` }); reload(); })}>Spara nyckel</button>
                <button className="btn" disabled={!usable || !!busy} onClick={() => act('test', async () => { const r = await api.post<{ version: string }>('/morningstar/test'); setMsg({ ok: true, text: `Anslutningen fungerar (morningstar_data ${r.version})` }); })}>{busy === 'test' ? 'Testar …' : 'Testa anslutning'}</button>
                {t.set && <button className="btn danger" disabled={!!busy} onClick={() => act('clear', async () => { await api.del('/morningstar/token'); reload(); })}>Ta bort nyckel</button>}
              </div>
            </div>
          )}
        </div>
        {msg && <div className={'alert mt ' + (msg.ok ? 'ok' : 'error')}>{msg.text}</div>}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Koppling av instrument</h2>
          {canEdit && <button className="btn" disabled={!usable || !!busy || !unmapped.some((i) => i.isin)} onClick={() => act('lookup', async () => { const r = await api.post<{ results: LookupRow[] }>('/morningstar/lookup'); setLookup(r.results); setChoice(Object.fromEntries(r.results.filter((x) => x.suggested).map((x) => [x.instrument_id, x.suggested!.sec_id]))); })}>
            {busy === 'lookup' ? 'Söker …' : `Sök koppling för ${unmapped.filter((i) => i.isin).length} okopplade`}
          </button>}
        </div>
        {lookup && (
          <div className="lookup-box">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <strong className="small">Förslag från Morningstar – bekräfta rätt listning</strong>
              {lookup.some((r) => r.clear) && <button className="btn small primary" onClick={() => act('all', async () => { for (const r of lookup.filter((x) => x.clear)) await confirm(r, r.suggested!.sec_id); })}>Bekräfta alla tydliga ({lookup.filter((r) => r.clear).length})</button>}
            </div>
            <table>
              <thead><tr><th>Instrument</th><th>ISIN</th><th>Listning hos Morningstar</th><th>Bedömning</th><th /></tr></thead>
              <tbody>
                {lookup.map((r) => (
                  <tr key={r.instrument_id}>
                    <td>{r.name}</td>
                    <td className="muted">{r.isin}</td>
                    <td>
                      {r.candidates.length ? (
                        <select value={choice[r.instrument_id] ?? ''} onChange={(e) => setChoice({ ...choice, [r.instrument_id]: e.target.value })}>
                          {r.candidates.map((c) => <option key={c.sec_id} value={c.sec_id}>{c.label} ({c.sec_id})</option>)}
                        </select>
                      ) : <span className="muted">{r.error ?? 'Ingen träff'}</span>}
                    </td>
                    <td>{r.candidates.length ? (r.clear ? <span className="badge ok">Tydlig: rätt valuta</span> : <span className="badge warn">Välj listning</span>) : <span className="badge err">Saknas</span>}</td>
                    <td className="num">{r.candidates.length > 0 && <button className="btn small" onClick={() => act(`c${r.instrument_id}`, () => confirm(r, choice[r.instrument_id]))}>Bekräfta</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DataTable
          rows={data.instruments}
          rowKey={(i) => i.id}
          search={(i) => `${i.name} ${i.isin ?? ''} ${i.ms_listing ?? ''}`}
          searchPlaceholder="Sök instrument"
          columns={[
            { key: 'n', label: 'Instrument', sortValue: (i) => i.name, render: (i) => <div className="name-cell"><Link to={`/instrument/${i.id}`}>{i.name}</Link><span className="sub">{TYPE_LABELS[i.type]} · {i.currency}</span></div> },
            { key: 'isin', label: 'ISIN', sortValue: (i) => i.isin, render: (i) => i.isin ?? <span className="muted">saknas – kan inte kopplas</span> },
            { key: 'ms', label: 'Morningstar', sortValue: (i) => i.ms_listing, render: (i) => (i.ms_secid ? <span title={i.ms_secid}>{i.ms_listing || i.ms_secid}</span> : <span className="badge">Ej kopplad</span>) },
            { key: 'd', label: 'Senaste kurs', sortValue: (i) => i.last_date, render: (i) => <span>{i.last_date ?? '–'} <span className="muted small">{i.last_source ?? ''}</span></span> },
            ...(canEdit ? [{ key: 'x', label: '', render: (i: Status['instruments'][number]) => (i.ms_secid ? <button className="btn small ghost danger" onClick={() => act(`u${i.id}`, async () => { await api.put(`/instruments/${i.id}/morningstar`, { sec_id: null }); reload(); })}>Koppla bort</button> : null) }] : []),
          ]}
        />
      </div>

      <div className="card">
        <div className="card-head"><h2>Hämta kurser</h2></div>
        {canEdit && (
          <div className="row" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
            <label className="field">Från datum (tomt = sedan senaste hämtning)<input type="date" value={from} max={today()} onChange={(e) => setFrom(e.target.value)} /></label>
            <button className="btn primary" disabled={!usable || !mapped.length || !!busy} onClick={() => act('sync', async () => { const r = await api.post<SyncResult>('/morningstar/sync', from ? { from } : {}); setSync(r); bump(); reload(); })}>
              {busy === 'sync' ? 'Hämtar …' : `Hämta kurser för ${mapped.length} instrument`}
            </button>
          </div>
        )}
        <p className="small muted" style={{ marginTop: 0 }}>Dagskurs för aktier och NAV-kurs för fonder. Manuellt inlagda kurser skrivs aldrig över. Varje hämtning räknas mot ert dagliga datautrymme hos Morningstar.</p>
        {sync && (
          <div className="mt">
            <div className="alert ok">{sync.total} kurser hämtade för perioden {sync.from} – {sync.to}.</div>
            <table>
              <thead><tr><th>Instrument</th><th className="num">Nya</th><th className="num">Uppdaterade</th><th className="num">Senaste kurs</th><th className="num">Avvikelse mot tidigare källa</th></tr></thead>
              <tbody>
                {sync.instruments.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}{s.skippedManual > 0 && <span className="muted small"> · {s.skippedManual} manuella behölls</span>}</td>
                    <td className="num">{s.inserted}</td><td className="num">{s.updated}</td>
                    <td className="num">{s.last ? `${fmt.price(s.last.price)} (${s.last.date})` : '–'}</td>
                    <td className={'num ' + (s.jump != null && Math.abs(s.jump) > 0.15 ? 'neg' : 'muted')}>{s.jump == null ? '–' : fmt.signedPct(s.jump)}{s.jump != null && Math.abs(s.jump) > 0.15 && ' – kontrollera'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sync.missing.length > 0 && <div className="alert mt">Ingen data för: {sync.missing.join(', ')}. Kontrollera kopplingen.</div>}
          </div>
        )}
        <h3 style={{ marginTop: 16 }}>Senaste hämtningar</h3>
        {data.log.length ? (
          <table>
            <tbody>{data.log.map((l) => <tr key={l.id}><td className="muted small">{l.ts.slice(0, 16)}</td><td>{l.summary}</td><td className="muted small">{l.user_name}</td></tr>)}</tbody>
          </table>
        ) : <div className="empty">Inga hämtningar ännu</div>}
      </div>
    </div>
  );
}
