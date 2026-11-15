import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.INNEHAV_DB = ':memory:';
process.env.MORNINGSTAR_BRIDGE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake_morningstar_bridge.py');
let M: typeof import('./morningstar.ts');
before(async () => { M = await import('./morningstar.ts'); });

const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;

test('nyckelns utgångstid läses ur JWT', () => {
  const exp = Math.floor(Date.parse('2030-01-01T00:00:00Z') / 1000);
  assert.equal(M.decodeJwtExpiry(jwt(exp)), '2030-01-01T00:00:00.000Z');
  assert.throws(() => M.decodeJwtExpiry('inte-en-nyckel'));
});

test('rätt listning väljs: valuta och hemmabörs före andra listningar', () => {
  const cands = [
    { sec_id: 'A', name: 'Volvo', ticker: '0HTP', isin: 'SE0000115446', currency: 'GBP', exchange: 'London Stock Exchange', country: 'Sweden', security_type: 'ST' },
    { sec_id: 'B', name: 'Volvo', ticker: 'VOLV B', isin: 'SE0000115446', currency: 'Swedish Krona', exchange: 'Nasdaq Stockholm', country: 'Sweden', security_type: 'ST' },
  ];
  const r = M.rankCandidates({ type: 'EQUITY', currency: 'SEK', isin: 'SE0000115446' }, cands);
  assert.equal(r.suggested?.sec_id, 'B');
  assert.equal(r.clear, true);
  const none = M.rankCandidates({ type: 'EQUITY', currency: 'USD', isin: 'SE0000115446' }, cands);
  assert.equal(none.clear, false, 'ingen listning i instrumentets valuta → måste väljas manuellt');
});

test('bryggan anropas med nyckeln och returnerar listningar och kurser', async () => {
  const lk = await M.bridge<{ result: Record<string, unknown[]> }>({ cmd: 'lookup', isins: ['SE0000115446'] }, 'nyckel');
  assert.equal(lk.result['SE0000115446'].length, 3);
  const pr = await M.bridge<{ rows: { price: number }[] }>({ cmd: 'prices', sec_ids: ['0P0000A6H8'], start: '2026-11-01', end: '2026-11-13' }, 'nyckel');
  assert.deepEqual(pr.rows.map((r) => r.price), [324, 323.4]);
  await assert.rejects(M.bridge({ cmd: 'ping' }, ''), /godkände inte nyckeln/);
});

test('utan angiven valuta väljs hemmamarknadens listning', () => {
  const cands = [
    { sec_id: 'L', name: 'Volvo', ticker: '0HTP', isin: 'SE0000115446', currency: 'GBP', exchange: 'London Stock Exchange', country: 'Sweden', security_type: 'ST' },
    { sec_id: 'S', name: 'Volvo', ticker: 'VOLV B', isin: 'SE0000115446', currency: 'Swedish Krona', exchange: 'Nasdaq Stockholm', country: 'Sweden', security_type: 'ST' },
  ];
  assert.equal(M.expectedCurrency('SE0000115446', cands), 'SEK');
  assert.equal(M.rankCandidates({ type: 'EQUITY', currency: M.expectedCurrency('SE0000115446', cands), isin: 'SE0000115446' }, cands).suggested?.sec_id, 'S');
});
