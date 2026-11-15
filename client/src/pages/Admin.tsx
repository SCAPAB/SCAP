import { useState } from 'react';
import { api } from '../api';
import { useApp, useFetch } from '../context';
import { DataTable, ErrorBox, Loading, Modal } from '../components/ui';
import type { Entity, Role } from '../../../shared/types';

export default function Admin() {
  const [tab, setTab] = useState<'entities' | 'users' | 'controls' | 'audit'>('entities');
  return (
    <div>
      <div className="page-head"><div><h1>Administration</h1><p>Juridiska enheter, användare och ändringslogg.</p></div></div>
      <div className="tabs">
        <button className={tab === 'entities' ? 'on' : ''} onClick={() => setTab('entities')}>Juridiska enheter</button>
        <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>Användare</button>
        <button className={tab === 'controls' ? 'on' : ''} onClick={() => setTab('controls')}>Kontroller</button>
        <button className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>Ändringslogg</button>
      </div>
      {tab === 'entities' && <Entities />}
      {tab === 'users' && <Users />}
      {tab === 'controls' && <Controls />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function Entities() {
  const { entities, bump } = useApp();
  const [edit, setEdit] = useState<Partial<Entity> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      if (edit?.id) await api.put(`/entities/${edit.id}`, edit);
      else await api.post('/entities', edit);
      setEdit(null);
      bump();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const del = async () => {
    if (!edit?.id || !confirm(`Ta bort ${edit.name}?`)) return;
    try {
      await api.del(`/entities/${edit.id}`);
      setEdit(null);
      bump();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card">
      <div className="card-head"><h2>Juridiska enheter</h2><button className="btn primary" onClick={() => { setError(null); setEdit({}); }}>+ Ny enhet</button></div>
      <DataTable rows={entities} rowKey={(e) => e.id} onRowClick={(e) => { setError(null); setEdit(e); }}
        columns={[
          { key: 'n', label: 'Namn', render: (e) => e.name },
          { key: 'o', label: 'Organisationsnummer', render: (e) => e.org_nr ?? '–' },
        ]} />
      {edit && (
        <Modal title={edit.id ? 'Redigera enhet' : 'Ny juridisk enhet'} onClose={() => setEdit(null)}
          footer={<>{edit.id && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={del}>Ta bort</button>}<button className="btn" onClick={() => setEdit(null)}>Avbryt</button><button className="btn primary" onClick={save}>Spara</button></>}>
          <div className="form-grid">
            <label className="field full">Namn<input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="field full">Organisationsnummer<input value={edit.org_nr ?? ''} onChange={(e) => setEdit({ ...edit, org_nr: e.target.value })} /></label>
            {error && <div className="alert error full">{error}</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

interface User { id: number; email: string; name: string; role: Role; created_at: string; password?: string }
const ROLES: Record<Role, string> = { admin: 'Administratör', editor: 'Redigerare', viewer: 'Läsare' };

function Users() {
  const { data, error, setData } = useFetch<User[]>('/users');
  const [edit, setEdit] = useState<Partial<User> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = () => api.get<User[]>('/users').then(setData);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const save = async () => {
    try {
      if (edit?.id) await api.put(`/users/${edit.id}`, edit);
      else await api.post('/users', edit);
      setEdit(null);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const del = async () => {
    if (!edit?.id || !confirm(`Ta bort ${edit.name}?`)) return;
    try {
      await api.del(`/users/${edit.id}`);
      setEdit(null);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="card">
      <div className="card-head"><h2>Användare</h2><button className="btn primary" onClick={() => { setErr(null); setEdit({ role: 'viewer' }); }}>+ Ny användare</button></div>
      <DataTable rows={data} rowKey={(u) => u.id} onRowClick={(u) => { setErr(null); setEdit(u); }}
        columns={[
          { key: 'n', label: 'Namn', render: (u) => u.name },
          { key: 'e', label: 'E-post', render: (u) => u.email },
          { key: 'r', label: 'Roll', render: (u) => <span className="badge">{ROLES[u.role]}</span> },
          { key: 'c', label: 'Skapad', render: (u) => <span className="muted">{u.created_at.slice(0, 10)}</span> },
        ]} />
      <p className="small muted">Läsare kan se allt. Redigerare kan dessutom registrera transaktioner, kurser och importera. Administratörer hanterar enheter och användare.</p>
      {edit && (
        <Modal title={edit.id ? 'Redigera användare' : 'Ny användare'} onClose={() => setEdit(null)}
          footer={<>{edit.id && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={del}>Ta bort</button>}<button className="btn" onClick={() => setEdit(null)}>Avbryt</button><button className="btn primary" onClick={save}>Spara</button></>}>
          <div className="form-grid">
            <label className="field full">Namn<input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="field">E-post<input type="email" value={edit.email ?? ''} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></label>
            <label className="field">Roll<select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value as Role })}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field full">{edit.id ? 'Nytt lösenord (lämna tomt för att behålla)' : 'Lösenord (minst 10 tecken)'}<input type="password" autoComplete="new-password" value={edit.password ?? ''} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></label>
            {err && <div className="alert error full">{err}</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Audit() {
  const { data, error } = useFetch<{ id: number; ts: string; user_name: string | null; action: string; object: string; object_id: string | null; details: string | null }[]>('/audit?limit=1000');
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const actions: Record<string, string> = { create: 'Skapad', update: 'Ändrad', delete: 'Borttagen', upsert: 'Sparad', import: 'Import', login: 'Inloggning', login_failed: 'Misslyckad inloggning' };
  return (
    <div className="card">
      <DataTable rows={data} rowKey={(a) => a.id} search={(a) => `${a.user_name ?? ''} ${a.action} ${a.object} ${a.details ?? ''}`} pageSize={50}
        columns={[
          { key: 't', label: 'Tid (UTC)', render: (a) => a.ts },
          { key: 'u', label: 'Användare', render: (a) => a.user_name ?? '–' },
          { key: 'a', label: 'Händelse', render: (a) => actions[a.action] ?? a.action },
          { key: 'o', label: 'Objekt', render: (a) => `${a.object}${a.object_id ? ' #' + a.object_id : ''}` },
          { key: 'd', label: 'Detaljer', render: (a) => <span className="muted small" title={a.details ?? ''}>{(a.details ?? '').slice(0, 90)}</span> },
        ]} />
    </div>
  );
}

function Controls() {
  const { data, setData } = useFetch<{ dual_control: boolean; report_lag_days: number }>('/settings');
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <Loading />;
  const save = async (patch: Partial<typeof data>) => {
    await api.put('/settings', patch);
    setData({ ...data, ...patch });
    setMsg('Sparat');
  };
  return (
    <div className="card">
      <h2>Interna kontroller</h2>
      <label className="row" style={{ alignItems: 'flex-start', gap: 10, margin: '8px 0 16px' }}>
        <input type="checkbox" checked={data.dual_control} onChange={(e) => save({ dual_control: e.target.checked })} style={{ marginTop: 3 }} />
        <span>
          <strong>Fyra ögon-principen för underlag i Inkorgen</strong>
          <div className="small muted">En användare granskar och markerar posten, en annan användare attesterar innan den bokförs. Rekommenderas för institutionell förvaltning.</div>
        </span>
      </label>
      <label className="field" style={{ maxWidth: 360 }}>Rapporteringstid för kvartalsrapporter (dagar efter kvartalsslut)
        <input type="number" min={15} max={180} defaultValue={data.report_lag_days} onBlur={(e) => save({ report_lag_days: Number(e.target.value) })} />
        <span className="small muted">Används i Rapportbevakning för att avgöra när en NAV-rapport är försenad. ILPA rekommenderar 45–60 dagar, i praktiken är 90 dagar vanligt.</span>
      </label>
      {msg && <div className="alert ok mt">{msg}</div>}
    </div>
  );
}
