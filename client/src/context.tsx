import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, qs } from './api';
import { today } from './format';
import type { Entity, Me } from '../../shared/types';

interface Ctx {
  me: Me;
  entities: Entity[];
  reloadEntities: () => void;
  selected: number[] | null; // null = alla
  setSelected: (s: number[] | null) => void;
  asOf: string;
  setAsOf: (d: string) => void;
  /** Querystring-delar för urval: entities + asOf */
  scope: { entities: string | null; asOf: string | null };
  scopeQs: (extra?: Record<string, string | number | null | undefined | boolean>) => string;
  canEdit: boolean;
  isAdmin: boolean;
  /** Ökas efter skrivningar så att vyer laddar om */
  version: number;
  bump: () => void;
  logout: () => void;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;

const load = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const save = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* ignorera */
  }
};

export function AppProvider({ me, onLogout, children }: { me: Me; onLogout: () => void; children: ReactNode }) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [selected, setSel] = useState<number[] | null>(() => load('innehav.entities', null));
  const [asOf, setAsOfState] = useState<string>(today());
  const [version, setVersion] = useState(0);

  const reloadEntities = useCallback(() => {
    api.get<Entity[]>('/entities').then(setEntities);
  }, []);
  useEffect(reloadEntities, [reloadEntities, version]);

  const setSelected = (s: number[] | null) => {
    setSel(s);
    save('innehav.entities', s);
  };
  const isToday = asOf === today();
  const scope = { entities: selected ? selected.join(',') || '0' : null, asOf: isToday ? null : asOf };
  const value: Ctx = {
    me, entities, reloadEntities, selected, setSelected, asOf, setAsOf: setAsOfState, scope,
    scopeQs: (extra = {}) => qs({ ...scope, ...extra }),
    canEdit: me.role !== 'viewer', isAdmin: me.role === 'admin', version, bump: () => setVersion((v) => v + 1),
    logout: () => {
      api.post('/auth/logout').finally(onLogout);
    },
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/** Enkel datahämtning med laddning/fel och omladdning när beroenden ändras. */
export function useFetch<T>(url: string | null, deps: unknown[] = []) {
  const { version } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api.get<T>(url)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, version, ...deps]);
  return { data, error, loading, setData };
}
