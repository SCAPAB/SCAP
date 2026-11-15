/**
 * Scenariotester: affärshändelser från början till slut via API:et, mot en tom och isolerad
 * instans av programmet. Varje scenario beskrivs i en JSON-fil i tests/scenarios/ med
 * handräknade förväntade värden. Se tests/scenarios/README.md för formatet.
 *
 * Kontroller och steg som är märkta med "kantFel" är kända fel som ännu inte är åtgärdade.
 * De körs och redovisas som TODO, men stoppar inte testkörningen. När felet är rättat tas
 * "kantFel" bort och kontrollen blir ett vanligt test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'tests', 'scenarios');

interface Steg { anrop: string; data?: unknown; spara?: string; forvantadStatus?: number; felInnehaller?: string; kantFel?: string; beskrivning?: string }
interface Kontroll { namn: string; hamta: string; falt?: string; forvantat?: unknown; tolerans?: number; innehaller?: string; arTal?: boolean; kantFel?: string }
interface Scenario { namn: string; beskrivning?: string; datum?: string; steg: Steg[]; kontroller: Kontroll[] }

// ---------------------------------------------------------------------------
// Testinstans
// ---------------------------------------------------------------------------

let nextPort = 3300 + (process.pid % 200);

async function startInstance(): Promise<{ base: string; stop: () => void }> {
  const tmp = mkdtempSync(join(tmpdir(), 'innehav-scenario-'));
  const port = nextPort++;
  const proc: ChildProcess = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', join(root, 'server', 'index.ts')], {
    env: { ...process.env, INNEHAV_DB: join(tmp, 'test.db'), PORT: String(port), MORNINGSTAR_BRIDGE: join(root, 'server', 'fixtures', 'fake_morningstar_bridge.py') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Testinstansen startade inte:\n${log}`)), 30_000);
    const onData = (d: Buffer) => {
      log += d;
      if (log.includes('lyssnar')) { clearTimeout(timer); resolve(); }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Testinstansen avslutades (${code}):\n${log}`)); });
  });
  return { base: `http://127.0.0.1:${port}`, stop: () => { proc.kill(); rmSync(tmp, { recursive: true, force: true }); } };
}

class Client {
  cookie = '';
  constructor(public base: string) {}
  async call(spec: string, data?: unknown) {
    const [method, path] = spec.trim().split(/\s+/, 2);
    const res = await fetch(this.base + path, {
      method,
      headers: { ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* text, t.ex. CSV */ }
    return { status: res.status, body };
  }
}

// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------

/** Ersätter {{alias}} med sparade värden. En sträng som bara är "{{alias}}" blir värdet självt (t.ex. ett tal). */
function fill(v: unknown, vars: Record<string, unknown>): unknown {
  if (typeof v === 'string') {
    const whole = v.match(/^\{\{(\w+)\}\}$/);
    if (whole) {
      if (!(whole[1] in vars)) throw new Error(`Okänt alias {{${whole[1]}}}`);
      return vars[whole[1]];
    }
    return v.replace(/\{\{(\w+)\}\}/g, (_, k) => {
      if (!(k in vars)) throw new Error(`Okänt alias {{${k}}}`);
      return String(vars[k]);
    });
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
}

/** Hämtar ett fält med punktnotation och filter: "pe[instrument.name=Testfond].tvpi", "rows[0].value". */
export function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.match(/[^.[\]]+|\[[^\]]*\]/g) ?? []) {
    if (cur == null) return undefined;
    if (part.startsWith('[')) {
      const inner = part.slice(1, -1);
      if (/^\d+$/.test(inner)) { cur = (cur as unknown[])[Number(inner)]; continue; }
      const [k, val] = inner.split('=');
      cur = (cur as unknown[]).find((x) => String(pick(x, k)) === val);
      continue;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function verify(k: Kontroll, body: unknown) {
  const v = k.falt ? pick(body, k.falt) : body;
  const where = `${k.hamta}${k.falt ? ' → ' + k.falt : ''}`;
  if (k.arTal) assert.ok(typeof v === 'number' && Number.isFinite(v), `${where}: förväntade ett tal, fick ${JSON.stringify(v)}`);
  if (k.innehaller !== undefined) assert.ok(JSON.stringify(v ?? '').includes(k.innehaller), `${where}: förväntade att innehålla "${k.innehaller}", fick ${JSON.stringify(v)?.slice(0, 300)}`);
  if ('forvantat' in k) {
    if (typeof k.forvantat === 'number') {
      const tol = k.tolerans ?? 0.01;
      assert.ok(typeof v === 'number' && Math.abs(v - k.forvantat) <= tol, `${where}: förväntat ${k.forvantat} (±${tol}), fick ${JSON.stringify(v)}`);
    } else {
      assert.deepEqual(v, k.forvantat, `${where}: förväntat ${JSON.stringify(k.forvantat)}, fick ${JSON.stringify(v)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Körning
// ---------------------------------------------------------------------------

const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

for (const file of files) {
  const sc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Scenario;
  test(`Scenario: ${sc.namn} (${file})`, async (t) => {
    const inst = await startInstance();
    try {
      const c = new Client(inst.base);
      const login = await c.call('POST /api/auth/login', { email: 'admin@innehav.local', password: 'innehav' });
      assert.equal(login.status, 200, 'Inloggning i testinstansen misslyckades');
      const vars: Record<string, unknown> = { datum: sc.datum ?? '' };
      let blocked: string | null = null;

      for (const [i, s] of sc.steg.entries()) {
        const label = `steg ${i + 1}: ${s.beskrivning ?? s.anrop}`;
        const run = async () => {
          const r = await c.call(fill(s.anrop, vars) as string, fill(s.data, vars));
          const want = s.forvantadStatus ?? (s.anrop.startsWith('POST') ? [200, 201] : [200]);
          const ok = Array.isArray(want) ? want.includes(r.status) : r.status === want;
          assert.ok(ok, `${label}: förväntad status ${JSON.stringify(want)}, fick ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
          if (s.felInnehaller) assert.ok(JSON.stringify(r.body).includes(s.felInnehaller), `${label}: felmeddelandet saknar "${s.felInnehaller}": ${JSON.stringify(r.body)}`);
          if (s.spara) vars[s.spara] = (r.body as { id?: unknown })?.id ?? r.body;
        };
        if (s.kantFel) {
          await t.test(`${label} [känt fel]`, { todo: s.kantFel }, run);
        } else {
          try {
            await run();
          } catch (e) {
            blocked = (e as Error).message;
            break;
          }
        }
      }
      if (blocked) assert.fail(`Scenariot kunde inte genomföras: ${blocked}`);

      for (const k of sc.kontroller) {
        await t.test(k.namn, k.kantFel ? { todo: k.kantFel } : {}, async () => {
          const hamta = fill(k.hamta, vars) as string;
          const r = await c.call(hamta);
          assert.equal(r.status, 200, `${hamta}: status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
          verify({ ...k, hamta }, r.body);
        });
      }
    } finally {
      inst.stop();
    }
  });
}
