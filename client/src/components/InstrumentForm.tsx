import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useApp } from '../context';
import { Modal } from './ui';
import { ASSET_CLASSES, suggestAssetClass, type Instrument, type InstrumentType } from '../../../shared/types';

const REGIONS = ['Norden', 'Europa', 'Nordamerika', 'Asien', 'Global', 'Tillväxtmarknader'];

export default function InstrumentForm({ initial, onClose, defaultType = 'EQUITY', prefill, onSaved }: { initial?: Instrument; onClose: () => void; defaultType?: InstrumentType; prefill?: Partial<Record<keyof Instrument, string>>; onSaved?: (id: number) => void }) {
  const { bump } = useApp();
  const [d, setD] = useState<Record<string, string>>(() =>
    initial ? Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v == null ? '' : String(v)])) : { type: defaultType, currency: 'SEK', region: 'Norden', ...Object.fromEntries(Object.entries(prefill ?? {}).filter(([, v]) => v)) },
  );
  const [error, setError] = useState<string | null>(null);
  const [ms, setMs] = useState<{ sec_id: string; listing: string } | null>(null);
  const [msBusy, setMsBusy] = useState(false);
  const [msNote, setMsNote] = useState<string | null>(null);
  const fromMorningstar = async () => {
    setMsBusy(true);
    setError(null);
    try {
      const r = await api.post<{ fields: Record<string, string | null>; ms: { sec_id: string; listing: string } }>('/morningstar/describe', { isin: d.isin, type: initial ? d.type : undefined, currency: initial ? d.currency : undefined });
      const filled = Object.entries(r.fields).filter(([k, v]) => v && (k === 'type' ? !initial : !d[k]));
      setD((x) => ({ ...x, ...Object.fromEntries(filled.map(([k, v]) => [k, String(v)])) }));
      setMs(r.ms);
      setMsNote(`Från Morningstar: ${filled.map(([k]) => k).length} fält ifyllda · listning ${r.ms.listing}. Kontrollera innan du sparar.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMsBusy(false);
    }
  };
  const set = (k: string) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));
  const t = d.type as InstrumentType;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (initial) {
        await api.put(`/instruments/${initial.id}`, d);
        if (ms) await api.put(`/instruments/${initial.id}/morningstar`, ms);
      } else {
        const r = await api.post<{ id: number }>('/instruments', d);
        if (ms) await api.put(`/instruments/${r.id}/morningstar`, ms);
        onSaved?.(r.id);
      }
      bump();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const del = async () => {
    if (!initial || !confirm(`Ta bort ${initial.name}?`)) return;
    try {
      await api.del(`/instruments/${initial.id}`);
      bump();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal
      title={initial ? `Redigera ${initial.name}` : 'Nytt instrument'}
      onClose={onClose}
      footer={
        <>
          {initial && <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={del}>Ta bort</button>}
          <button type="button" className="btn" onClick={onClose}>Avbryt</button>
          <button className="btn primary" form="insform">Spara</button>
        </>
      }
    >
      <form id="insform" className="form-grid" onSubmit={submit}>
        <label className="field">Typ
          <select value={d.type} onChange={set('type')} disabled={!!initial}>
            <option value="EQUITY">Direktägd aktie</option>
            <option value="FUND">Öppen fond</option>
            <option value="PE_FUND">Sluten fond (PE, infrastruktur, fastigheter …)</option>
          </select>
        </label>
        <label className="field">Valuta<input value={d.currency ?? ''} onChange={set('currency')} maxLength={3} required style={{ textTransform: 'uppercase' }} /></label>
        <label className="field full">Namn<input value={d.name ?? ''} onChange={set('name')} required /></label>
        <label className="field">ISIN
          <span className="row" style={{ flexWrap: 'nowrap' }}>
            <input value={d.isin ?? ''} onChange={set('isin')} maxLength={12} style={{ textTransform: 'uppercase', flex: 1, minWidth: 0 }} />
            {d.type !== 'PE_FUND' && <button type="button" className="btn small" disabled={msBusy || !/^[A-Za-z]{2}[A-Za-z0-9]{9}\d$/.test(d.isin ?? '')} onClick={fromMorningstar} title="Hämta namn, valuta, bransch/kategori och koppling från Morningstar">{msBusy ? 'Hämtar …' : 'Morningstar'}</button>}
          </span>
        </label>
        {msNote && <div className="alert ok full" style={{ margin: 0 }}>{msNote}</div>}
        {t !== 'PE_FUND' && <label className="field">Ticker<input value={d.ticker ?? ''} onChange={set('ticker')} /></label>}
        <label className="field">Land (ISO)<input value={d.country ?? ''} onChange={set('country')} maxLength={2} style={{ textTransform: 'uppercase' }} /></label>
        <label className="field">Tillgångsslag
          <select value={d.asset_class || suggestAssetClass(d as unknown as Instrument).asset_class} onChange={(e) => setD((x) => ({ ...x, asset_class: e.target.value, sub_class: '' }))}>
            {ASSET_CLASSES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
        </label>
        <label className="field">Delsegment
          <select value={d.sub_class ?? ''} onChange={set('sub_class')}>
            <option value="">{`Automatiskt (${suggestAssetClass(d as unknown as Instrument).sub_class})`}</option>
            {(ASSET_CLASSES.find((a) => a.key === (d.asset_class || suggestAssetClass(d as unknown as Instrument).asset_class))?.subs ?? []).map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
        <label className="field">Region
          <select value={d.region ?? ''} onChange={set('region')}>
            <option value="">–</option>
            {REGIONS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label className="field">{t === 'EQUITY' ? 'Bransch' : 'Inriktning'}<input value={d.sector ?? ''} onChange={set('sector')} /></label>
        {t === 'FUND' && (
          <label className="field">Fondkategori
            <select value={d.fund_category ?? ''} onChange={set('fund_category')}>
              <option value="">–</option>
              <option>Aktiefond</option><option>Räntefond</option><option>Blandfond</option><option>Hedgefond</option><option>Alternativ</option>
            </select>
          </label>
        )}
        {t !== 'EQUITY' && <label className="field">{t === 'PE_FUND' ? 'Förvaltare (GP)' : 'Fondbolag'}<input value={d.manager ?? ''} onChange={set('manager')} /></label>}
        {t === 'PE_FUND' && (
          <>
            <label className="field">Strategi
              <select value={d.strategy ?? ''} onChange={set('strategy')}>
                <option value="">–</option>
                {['Buyout', 'Growth', 'Venture', 'Infrastruktur', 'Fastigheter', 'Private debt', 'Secondaries', 'Fund of funds'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
            <label className="field">Vintage<input type="number" value={d.vintage ?? ''} onChange={set('vintage')} /></label>
          </>
        )}
        {error && <div className="alert error full" style={{ margin: 0 }}>{error}</div>}
      </form>
    </Modal>
  );
}
