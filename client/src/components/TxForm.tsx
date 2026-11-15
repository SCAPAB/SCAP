import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useApp, useFetch } from '../context';
import { Modal } from './ui';
import { fmt, today } from '../format';
import { LISTED_TX_TYPES, PE_TX_TYPES, TX_LABELS, type Instrument, type Transaction, type TxType } from '../../../shared/types';

type Draft = Partial<Record<keyof Transaction, string>>;

export default function TxForm({ initial, instrumentId, onClose }: { initial?: Transaction; instrumentId?: number; onClose: () => void }) {
  const { entities, selected, bump } = useApp();
  const { data: instruments } = useFetch<Instrument[]>('/instruments');
  const [d, setD] = useState<Draft>(() =>
    initial
      ? Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v == null ? '' : String(v)]))
      : {
        entity_id: String(selected?.length === 1 ? selected[0] : entities[0]?.id ?? ''),
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
    COMMITMENT: 'Åtagandebelopp', CALL: 'Anropat belopp', DISTRIBUTION: 'Utdelat belopp',
  };
  const feeLabel = d.type === 'DIVIDEND' ? 'Källskatt' : d.type === 'BUY' || d.type === 'SELL' ? 'Courtage' : 'Avgift';

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
        <label className="field">Juridisk enhet
          <select value={d.entity_id} onChange={set('entity_id')} required>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
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
        {ins && ins.currency !== 'SEK' && (
          <label className="field">Valutakurs SEK/{ins.currency}<input inputMode="decimal" value={d.fx_rate} onChange={set('fx_rate')} placeholder="Hämtas automatiskt" /></label>
        )}
        <label className="field full">Notering<input value={d.note ?? ''} onChange={set('note')} maxLength={500} /></label>
        {error && <div className="alert error full" style={{ margin: 0 }}>{error}</div>}
      </form>
    </Modal>
  );
}
