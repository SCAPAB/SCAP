import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useApp, useFetch } from '../context';
import { Modal } from './ui';
import { fmt, today } from '../format';
import { LISTED_TX_TYPES, PE_TX_TYPES, TX_LABELS, type Instrument, type Transaction, type TxType } from '../../../shared/types';

type Draft = Partial<Record<keyof Transaction, string>>;

export default function TxForm({ initial, instrumentId, onClose }: { initial?: Transaction; instrumentId?: number; onClose: () => void }) {
  const { entities, bump } = useApp();
  const { data: instruments } = useFetch<Instrument[]>('/instruments');
  const [d, setD] = useState<Draft>(() =>
    initial
      ? Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v == null ? '' : String(k === 'amount' && initial.type === 'CALL' ? initial.amount + initial.fee : v)]))
      : {
        entity_id: String(entities[0]?.id ?? ''),
        instrument_id: instrumentId ? String(instrumentId) : '',
        type: '', trade_date: today(), quantity: '', price: '', amount: '', fee: '', fx_rate: '', note: '',
      },
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ins = useMemo(() => instruments?.find((i) => String(i.id) === d.instrument_id), [instruments, d.instrument_id]);
  const types: TxType[] = ins?.type === 'PE_FUND' ? PE_TX_TYPES : LISTED_TX_TYPES;
  useEffect(() => {
    if (ins && !types.includes(d.type as TxType)) setD((x) => ({ ...x, type: types[ins.type === 'PE_FUND' ? 1 : 0] }));
  }, [ins]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof Transaction) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));
  // Valutakurs som hämtas automatiskt (högst 7 dagar före affärsdagen) – visas med kursens datum
  const [fxAuto, setFxAuto] = useState<{ rate: number | null; date: string | null; message?: string } | null>(null);
  const needFx = !!ins && ins.currency !== 'SEK' && !d.fx_rate && !!d.trade_date && d.type !== 'COMMITMENT';
  useEffect(() => {
    if (!needFx || !ins) { setFxAuto(null); return; }
    let alive = true;
    api.get<{ rate: number | null; date: string | null; message?: string }>(`/fx-lookup?currency=${ins.currency}&date=${d.trade_date}`)
      .then((r) => alive && setFxAuto(r)).catch(() => alive && setFxAuto(null));
    return () => { alive = false; };
  }, [needFx, ins, d.trade_date]);
  const isTrade = d.type === 'BUY' || d.type === 'SELL';
  const parse = (s?: string) => (s ? Number(s.replace(/\s/g, '').replace(',', '.')) : NaN);
  const computed = isTrade && !d.amount ? parse(d.quantity) * parse(d.price) : NaN;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...d, amount: d.amount || (isFinite(computed) ? String(computed) : '') };
      if (initial) await api.put(`/transactions/${initial.id}`, body);
      else await api.post('/transactions', body);
      bump();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!initial || !confirm('Ta bort transaktionen? Åtgärden loggas.')) return;
    await api.del(`/transactions/${initial.id}`);
    bump();
    onClose();
  };

  const amountLabel: Record<string, string> = {
    BUY: 'Likvidbelopp (antal × kurs)', SELL: 'Likvidbelopp (antal × kurs)', DIVIDEND: 'Bruttoutdelning', FEE: 'Avgiftsbelopp',
    COMMITMENT: 'Åtagandebelopp', CALL: 'Totalt anropat belopp (enligt avin)', DISTRIBUTION: 'Utdelat belopp (brutto)',
  };
  const feeLabel = d.type === 'DIVIDEND' ? 'Källskatt' : d.type === 'BUY' || d.type === 'SELL' ? 'Courtage' : d.type === 'CALL' ? 'Varav avgifter' : d.type === 'DISTRIBUTION' ? 'Avdrag/källskatt' : 'Avgift';

  return (
    <Modal
      title={initial ? 'Redigera transaktion' : 'Ny transaktion'}
      onClose={onClose}
      footer={
        <>
          {initial && <button type="button" className="btn danger" onClick={del} style={{ marginRight: 'auto' }}>Ta bort</button>}
          <button type="button" className="btn" onClick={onClose}>Avbryt</button>
          <button className="btn primary" form="txform" disabled={busy}>{busy ? 'Sparar …' : 'Spara'}</button>
        </>
      }
    >
      <form id="txform" onSubmit={submit} className="form-grid">
        <label className="field full">Instrument
          <select value={d.instrument_id} onChange={set('instrument_id')} required>
            <option value="">Välj …</option>
            {(['EQUITY', 'FUND', 'PE_FUND'] as const).map((t) => (
              <optgroup key={t} label={{ EQUITY: 'Aktier', FUND: 'Fonder', PE_FUND: 'PE-fonder' }[t]}>
                {instruments?.filter((i) => i.type === t).map((i) => <option key={i.id} value={i.id}>{i.name} ({i.currency})</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="field">Typ
          <select value={d.type} onChange={set('type')} required>
            {types.map((t) => <option key={t} value={t}>{TX_LABELS[t]}</option>)}
          </select>
        </label>
        <label className="field">Affärsdag<input type="date" value={d.trade_date} onChange={set('trade_date')} required /></label>
        <label className="field">Likviddag<input type="date" value={d.settle_date ?? ''} onChange={set('settle_date')} /></label>
        {isTrade && (
          <>
            <label className="field">Antal<input inputMode="decimal" value={d.quantity} onChange={set('quantity')} required /></label>
            <label className="field">Kurs ({ins?.currency ?? '–'})<input inputMode="decimal" value={d.price} onChange={set('price')} required /></label>
          </>
        )}
        {d.type === 'DIVIDEND' && <label className="field">Utdelning per aktie<input inputMode="decimal" value={d.price} onChange={set('price')} /></label>}
        <label className="field">{amountLabel[d.type ?? ''] ?? 'Belopp'} ({ins?.currency ?? '–'})
          <input inputMode="decimal" value={d.amount} onChange={set('amount')} required={!isTrade} placeholder={isFinite(computed) ? fmt.num(computed) : ''} />
        </label>
        {d.type !== 'COMMITMENT' && <label className="field">{feeLabel} ({ins?.currency ?? '–'})<input inputMode="decimal" value={d.fee} onChange={set('fee')} /></label>}
        {d.type === 'CALL' && (
          <label className="field">Varav utjämningsränta ({ins?.currency ?? '–'})
            <input inputMode="decimal" value={d.outside_commitment ?? ''} onChange={set('outside_commitment')} placeholder="0" />
            <span className="small muted">Utanför åtagandet – minskar inte outnyttjat åtagande</span>
          </label>
        )}
        {d.type === 'DISTRIBUTION' && (
          <label className="field">Varav återinkallningsbart ({ins?.currency ?? '–'})
            <input inputMode="decimal" value={d.recallable ?? ''} onChange={set('recallable')} placeholder="0" />
            <span className="small muted">Kan anropas igen – ökar outnyttjat åtagande</span>
          </label>
        )}
        {ins && ins.currency !== 'SEK' && d.type !== 'COMMITMENT' && (
          <label className="field">Valutakurs SEK/{ins.currency}
            <input inputMode="decimal" value={d.fx_rate} onChange={set('fx_rate')} placeholder={fxAuto?.rate ? fmt.dec(fxAuto.rate, 4) : 'Hämtas automatiskt'} />
            {needFx && fxAuto?.rate != null && <span className="small muted">Hämtas automatiskt: kurs per {fxAuto.date}</span>}
            {needFx && fxAuto && fxAuto.rate == null && <span className="small neg">{fxAuto.message}</span>}
          </label>
        )}
        {d.type === 'CALL' && (
          <div className="full small muted">
            Ange beloppet som det står på avin: totalt anropat belopp inklusive avgifter. Investeringsdelen (som ökar NAV) blir {fmt.num(Math.max(0, parse(d.amount) - (parse(d.fee) || 0)))} {ins?.currency}.
          </div>
        )}
        <label className="field full">Notering<input value={d.note ?? ''} onChange={set('note')} maxLength={500} /></label>
        {error && <div className="alert error full" style={{ margin: 0 }}>{error}</div>}
      </form>
    </Modal>
  );
}
