import { useEffect, useState, type FormEvent } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { AppProvider, useApp } from './context';
import { today } from './format';
import type { Me } from '../../shared/types';
import Overview from './pages/Overview';
import AssetClass from './pages/AssetClass';
import Allocation from './pages/Allocation';
import Performance from './pages/Performance';
import Liquidity from './pages/Liquidity';
import Reporting from './pages/Reporting';
import { ASSET_CLASSES } from '../../shared/types';
import InstrumentDetail from './pages/InstrumentDetail';
import Transactions from './pages/Transactions';
import Instruments from './pages/Instruments';
import MarketData from './pages/MarketData';
import ImportPage from './pages/Import';
import Reports from './pages/Reports';
import Admin from './pages/Admin';
import Inbox from './pages/Inbox';
import Review from './pages/Review';
import Rules from './pages/Rules';
import { useFetch } from './context';

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    api.get<Me>('/auth/me').then(setMe).catch(() => setMe(null));
    const h = () => setMe(null);
    window.addEventListener('innehav:unauthorized', h);
    return () => window.removeEventListener('innehav:unauthorized', h);
  }, []);
  if (me === undefined) return null;
  if (!me) return <Login onLogin={setMe} />;
  return (
    <BrowserRouter>
      <AppProvider me={me} onLogout={() => setMe(null)}>
        <Shell />
      </AppProvider>
    </BrowserRouter>
  );
}

function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.post<Me>('/auth/login', { email, password }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <div className="card">
        <Brand />
        <form onSubmit={submit}>
          <label className="field">E-postadress<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
          <label className="field">Lösenord<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {error && <div className="alert error" style={{ margin: 0 }}>{error}</div>}
          <button className="btn primary" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Loggar in …' : 'Logga in'}</button>
        </form>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="wordmark">Innehav</span>
      <span className="tagline">Portföljsystem · SCAP</span>
    </div>
  );
}

const NAV: { group?: string; to: string; label: string; admin?: boolean; badge?: 'inbox' | 'attest' }[] = [
  { group: 'Portfölj', to: '/', label: 'Översikt' },
  { to: '/allokering', label: 'Allokering mot policy' },
  { to: '/avkastning', label: 'Avkastning' },
  { to: '/likviditet', label: 'Likviditet och åtaganden' },
  ...ASSET_CLASSES.map((a, i) => ({ group: i === 0 ? 'Tillgångsslag' : undefined, to: `/tillgangsslag/${a.path}`, label: a.label })),
  { group: 'Operativt', to: '/inkorg', label: 'Inkorg', badge: 'inbox' as const },
  { to: '/rapportbevakning', label: 'Rapportbevakning' },
  { to: '/transaktioner', label: 'Transaktioner' },
  { to: '/marknadsdata', label: 'Kurser och valutor' },
  { to: '/import', label: 'Import' },
  { group: 'Register och rapporter', to: '/instrument', label: 'Instrument' },
  { to: '/rapporter', label: 'Rapporter' },
  { to: '/admin', label: 'Administration', admin: true },
];

function Shell() {
  const { me, entity, asOf, setAsOf, logout, isAdmin } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenuOpen(false), [loc.pathname]);
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPoll((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const { data: counts } = useFetch<{ toReview: number | null; processing: number | null }>('/documents/counts', [poll, loc.pathname]);
  return (
    <div className="app">
      <aside className={'sidebar' + (menuOpen ? ' open' : '')}>
        <Brand />
        <nav className="nav">
          {NAV.filter((n) => !n.admin || isAdmin).map((n) => (
            <div key={n.to}>
              {n.group && <div className="nav-group">{n.group}</div>}
              <NavLink to={n.to} end={n.to !== '/inkorg'}>
                {n.label}
                {n.badge === 'inbox' && !!counts?.toReview && <span className="nav-count" title="Dokument att hantera">{counts.toReview}</span>}
              </NavLink>
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <strong>{me.name}</strong>
          {me.email} · {{ admin: 'Administratör', editor: 'Redigerare', viewer: 'Läsare' }[me.role]}
          <div><button className="btn small" style={{ marginTop: 8 }} onClick={logout}>Logga ut</button></div>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <button className="btn menu-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="Meny">☰</button>
          <span className="org-name" title="Juridisk enhet som förvaltas">{entity?.name}{entity?.org_nr ? <span className="muted"> · {entity.org_nr}</span> : null}</span>
          <span className="spacer" />
          <label className="row small muted">
            Per datum
            <input type="date" value={asOf} max={today()} onChange={(e) => e.target.value && setAsOf(e.target.value)} />
            {asOf !== today() && <button className="btn small" onClick={() => setAsOf(today())}>I dag</button>}
          </label>
        </div>
        <div className="content">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/allokering" element={<Allocation />} />
            <Route path="/avkastning" element={<Performance />} />
            <Route path="/likviditet" element={<Liquidity />} />
            <Route path="/rapportbevakning" element={<Reporting />} />
            <Route path="/tillgangsslag/:path" element={<AssetClass />} />
            <Route path="/instrument/:id" element={<InstrumentDetail />} />
            <Route path="/transaktioner" element={<Transactions />} />
            <Route path="/instrument" element={<Instruments />} />
            <Route path="/marknadsdata" element={<MarketData />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/inkorg" element={<Inbox />} />
            <Route path="/inkorg/regler" element={<Rules />} />
            <Route path="/inkorg/:id" element={<Review />} />
            <Route path="/rapporter" element={<Reports />} />
            <Route path="/admin" element={isAdmin ? <Admin /> : <Navigate to="/" />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
