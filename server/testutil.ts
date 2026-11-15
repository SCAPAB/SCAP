/** Hjälpfunktioner för HTTP-tester mot en Express-instans med databas i minnet. */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

export interface Client {
  call: <T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: T; headers: Headers }>;
  login: (email: string, password: string) => Promise<number>;
  cookie: string | null;
}

let server: Server | null = null;
let base = '';

export async function startServer() {
  process.env.INNEHAV_DB = ':memory:';
  const { createApp } = await import('./app.ts');
  const app = createApp({ serveClient: false });
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

export function stopServer() {
  server?.close();
}

export function client(): Client {
  const c: Client = {
    cookie: null,
    async call(method, path, body, headers = {}) {
      const res = await fetch(base + '/api' + path, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set && set.startsWith('innehav_session=')) c.cookie = set.split(';')[0];
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: res.status, body: parsed as never, headers: res.headers };
    },
    async login(email, password) {
      const r = await c.call('POST', '/auth/login', { email, password });
      return r.status;
    },
  };
  return c;
}
