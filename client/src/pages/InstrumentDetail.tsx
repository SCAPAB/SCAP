import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useApp, useFetch } from '../context';
import { DataTable, ErrorBox, Kpi, Loading, Modal } from '../components/ui';
import { PriceChart } from '../components/charts';
import TxForm from '../components/TxForm';
import InstrumentForm from '../components/InstrumentForm';
import { fmt, tone, today } from '../format';
import { ASSET_CLASSES, TX_LABELS, txAmount, TYPE_LABELS, type Instrument, type ListedHolding, type PeHolding, type Transaction } from '../../../shared/types';

type Tx = Transaction & { entity_name: string; document_id: number | null };
type Val = { entity_id: number; instrument_id: number; date: string; nav: number; source: string; entity_name: string };
interface Resp {
  instrument: Instrument;
  total: (ListedHolding & PeHolding) | null;
  perEntity: ((ListedHolding & PeHolding) & { entityName: string })[];
  transactions: Tx[];
  prices: { date: string; price: number }[];
  valuations: Val[];
}

export default function InstrumentDetail() {
  const { id } = useParams();
  const { scopeQs, canEdit, bump, entities } = useApp();
  const { data, error } = useFetch<Resp>(`/instruments/${id}` + scopeQs());
  const [editTx, setEditTx] = useState<Tx | 'new' | null>(null);
  const [editIns, setEditIns] = useState(false);
  const [navForm, setNavForm] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const { instrument: ins, total: h } = data;
  const pe = ins.type === 'PE_FUND';
  const ac = ASSET_CLASSES.find((a) => a.key === ins.asset_class);

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="small">{ac && <Link to={`/tillgangsslag/${ac.path}`}>← {ac.label}</Link>}</div>
          <h1>{ins.name}</h1>
          <p>
            {[ac?.label, ins.sub_class, TYPE_LABELS[ins.type], ins.isin, ins.ticker, ins.currency, ins.sector, ins.manager, ins.vintage && `Vintage ${ins.vintage}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        {canEdit && (
          <div className="row">
            <button className="btn" onClick={() => setEditIns(true)}>Redigera instrument</button>
            {pe && <button className="btn" onClick={() => setNavForm(true)}>+ NAV-rapport</button>}
            <button className="btn primary" onClick={() => setEditTx('new')}>+ Ny transaktion</button>
          </div>
        )}
      </div>

      {h && !pe && (
        <div className="kpis">
          <Kpi hero label="Marknadsvärde" value={fmt.msek(h.mvBase)} sub={`${fmt.qty(h.quantity)} st à ${fmt.price(h.price)} ${ins.currency} (${h.priceDate ?? '–'})`} />
          <Kpi label="GAV" value={`${fmt.price(h.avgCostLocal)} ${ins.currency}`} sub={`Anskaffningsvärde ${fmt.msek(h.costBase)}`} />
          <Kpi label="Orealiserat" value={fmt.msek(h.unrealizedBase)} tone={tone(h.unrealizedBase)} sub={`${fmt.signedPct(h.unrealizedPct)} · varav valuta ${fmt.msek(h.fxEffectBase)}`} />
          <Kpi label="Realiserat" value={fmt.msek(h.realizedBase)} tone={tone(h.realizedBase)} />
          <Kpi label="Utdelningar" value={fmt.msek(h.dividendsBase)} />
        </div>
      )}
      {h && pe && (
        <div className="kpis">
          <Kpi hero label="NAV" value={`${fmt.msek(h.navBase)}`} sub={`${fmt.num(h.nav)} ${ins.currency}${h.navEstimated ? ' (framräknat)' : ''}`} />
          <Kpi label="Åtagande" value={`${fmt.num(h.commitment)} ${ins.currency}`} sub={`Anropat ${fmt.pct(h.calledPct)} · outnyttjat ${fmt.num(h.uncalled)}`} />
          <Kpi label="Inbetalt / utdelat" value={fmt.num(h.paidIn)} sub={`Utdelat ${fmt.num(h.distributed)} ${ins.currency}`} />
          <Kpi label="TVPI / DPI / RVPI" value={fmt.multiple(h.tvpi)} sub={`DPI ${fmt.multiple(h.dpi)} · RVPI ${fmt.multiple(h.rvpi)}`} />
          <Kpi label="IRR" value={fmt.pct(h.irr)} tone={tone(h.irr)} sub={`I SEK ${fmt.pct(h.irrBase)}`} />
        </div>
      )}
      {!h && <div className="alert">Inga transaktioner registrerade för instrumentet.</div>}

      <div className="grid g-main">
        <div className="stack">
          {!pe && (
            <div className="card">
              <div className="card-head"><h2>Kurs ({ins.currency})</h2></div>
              <PriceChart data={data.prices} currency={ins.currency} />
            </div>
          )}
          <div className="card">
            <div className="card-head"><h2>Transaktioner</h2></div>
            <DataTable
              rows={data.transactions}
              rowKey={(t) => t.id}
              onRowClick={canEdit ? (t) => setEditTx(t) : undefined}
              pageSize={25}
              columns={[
                { key: 'd', label: 'Affärsdag', sortValue: (t) => t.trade_date, render: (t) => t.trade_date },
                { key: 't', label: 'Typ', render: (t) => TX_LABELS[t.type] },
                ...(!pe ? [{ key: 'q', label: 'Antal', num: true, render: (t: Tx) => (t.quantity ? fmt.qty(t.quantity) : '') }, { key: 'p', label: 'Kurs', num: true, render: (t: Tx) => (t.price ? fmt.price(t.price) : '') }] : []),
                { key: 'a', label: `Belopp ${ins.currency}`, title: pe ? 'Kapitalanrop: totalt anropat belopp inklusive avgifter' : undefined, num: true, render: (t) => fmt.dec(txAmount(t)) },
                { key: 'f', label: pe ? 'Varav avgift' : 'Avgift', num: true, render: (t) => (t.fee ? fmt.dec(t.fee) : '') },
                { key: 'fx', label: 'Valutakurs', num: true, render: (t) => (ins.currency === 'SEK' ? '' : fmt.dec(t.fx_rate, 4)) },
                { key: 'n', label: 'Notering', render: (t) => <span className="muted">{t.note}</span> },
                { key: 'src', label: 'Källa', render: (t) => (t.document_id ? <Link to={`/inkorg/${t.document_id}`} onClick={(e) => e.stopPropagation()}>Dokument</Link> : '') },
              ]}
            />
          </div>
          {pe && (
            <div className="card">
              <div className="card-head"><h2>NAV-rapporter ({ins.currency})</h2></div>
              <DataTable
                rows={data.valuations}
                rowKey={(v) => `${v.entity_id}-${v.date}`}
                pageSize={12}
                columns={[
                  { key: 'd', label: 'Rapportdatum', render: (v) => v.date },
                  { key: 'n', label: 'NAV', num: true, render: (v) => fmt.dec(v.nav) },
                  { key: 's', label: 'Källa', render: (v) => <span className="muted">{v.source}</span> },
                  ...(canEdit ? [{
                    key: 'x', label: '', render: (v: Val) => (
                      <button className="btn small ghost danger" onClick={async () => {
                        if (!confirm('Ta bort NAV-rapporten?')) return;
                        await api.del(`/valuations/${v.entity_id}/${v.instrument_id}/${v.date}`);
                        bump();
                      }}>Ta bort</button>
                    ),
                  }] : []),
                ]}
              />
            </div>
          )}
        </div>
        <div className="stack">
          <div className="card">
            <h2>Instrumentfakta</h2>
            <dl className="facts">
              <dt>Tillgångsslag</dt><dd>{ac?.label ?? '–'}{ins.sub_class ? ` · ${ins.sub_class}` : ''}</dd>
              <dt>Förvaltningsform</dt><dd>{TYPE_LABELS[ins.type]}</dd>
              <dt>Valuta</dt><dd>{ins.currency}</dd>
              {ins.isin && <><dt>ISIN</dt><dd>{ins.isin}</dd></>}
              {ins.ticker && <><dt>Ticker</dt><dd>{ins.ticker}</dd></>}
              {ins.manager && <><dt>{pe ? 'Förvaltare (GP)' : 'Fondbolag'}</dt><dd>{ins.manager}</dd></>}
              {ins.vintage && <><dt>Vintage</dt><dd>{ins.vintage}</dd></>}
              {ins.sector && <><dt>{ins.type === 'EQUITY' ? 'Bransch' : 'Inriktning'}</dt><dd>{ins.sector}</dd></>}
              {!pe && <><dt>Morningstar</dt><dd>{(ins as Instrument & { ms_listing?: string | null }).ms_listing ?? <span className="muted">ej kopplad</span>}</dd></>}
              {h && !pe && <><div className="sep" /><dt>Kursdatum</dt><dd>{h.priceDate ?? '–'}</dd><dt>Realiserat SEK</dt><dd>{fmt.sek(h.realizedBase)}</dd></>}
              {h && pe && <><div className="sep" /><dt>Senaste NAV-rapport</dt><dd>{h.navReportDate ?? '–'}</dd><dt>Fees (utanför NAV)</dt><dd>{fmt.num(h.fees)}</dd></>}
            </dl>
          </div>
        </div>
      </div>
      {editTx && <TxForm initial={editTx === 'new' ? undefined : editTx} instrumentId={ins.id} onClose={() => setEditTx(null)} />}
      {editIns && <InstrumentForm initial={ins} onClose={() => setEditIns(false)} />}
      {navForm && <NavForm instrument={ins} entityId={entities[0]?.id} onClose={() => setNavForm(false)} onSaved={bump} />}
    </div>
  );
}

function NavForm({ instrument, entityId, onClose, onSaved }: { instrument: Instrument; entityId?: number; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(today());
  const [nav, setNav] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api.post('/valuations', { entity_id: entityId, instrument_id: instrument.id, date, nav, source: 'Manuell' });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`NAV-rapport – ${instrument.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Avbryt</button><button className="btn primary" onClick={save}>Spara</button></>}>
      <div className="form-grid">
        <label className="field">Rapportdatum (värderingsdag)<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field full">NAV för vår andel ({instrument.currency})<input inputMode="decimal" value={nav} onChange={(e) => setNav(e.target.value)} /></label>
        {error && <div className="alert error full">{error}</div>}
      </div>
    </Modal>
  );
}
