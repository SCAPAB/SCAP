/**
 * Tester av agentflödenas tekniska spärrar: hooken .claude/hooks/agentvakt.mjs och
 * beslutskontrollen scripts/kontrollera-beslut.mjs som körs på GitHub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vaktFil = join(root, '.claude', 'hooks', 'agentvakt.mjs');
const beslutFil = join(root, 'scripts', 'kontrollera-beslut.mjs');
// Dynamisk import via variabel: skripten är vanlig JavaScript utan typer.
const { bedom } = (await import(vaktFil)) as { bedom: (input: unknown, miljo?: unknown) => string | null };
const { kontrollera } = (await import(beslutFil)) as {
  kontrollera: (p: { forslag: string; commits: string[]; beslutAndrat: boolean }) => { fel: string[]; varningar: string[]; godkanda: string[] };
};

const cwd = '/repo';
const PA_GREN = (g: string) => ({ aktuellGren: () => g, finnsFil: () => null });
const bash = (command: string, agent?: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd, ...(agent ? { agent_type: agent, agent_id: 'a1' } : {}) });

test('push till main stoppas i alla former, push till en egen gren släpps igenom', () => {
  const m = PA_GREN('forbattring/2026-11-15');
  for (const cmd of [
    'git push origin main',
    'git -c push.negotiate=true push origin main',
    'git push -u origin HEAD:main',
    'git push origin +main',
    'git push origin refs/heads/main',
    'git push --all origin',
    'git add -A && git commit -m x && git push origin main',
    'cd /x; git push --force origin feature:main',
  ]) assert.ok(bedom(bash(cmd), m), `skulle stoppas: ${cmd}`);
  for (const cmd of ['git push -u origin forbattring/2026-11-15', 'git push', 'git push origin HEAD', 'git log main..HEAD', 'git fetch origin main']) {
    assert.equal(bedom(bash(cmd), m), null, `skulle släppas igenom: ${cmd}`);
  }
  // Står man på main stoppas push utan angiven gren
  assert.ok(bedom(bash('git push'), PA_GREN('main')));
  assert.ok(bedom(bash('git push origin HEAD'), PA_GREN('main')));
  assert.ok(bedom(bash('git push origin main'), PA_GREN('main')), 'gäller även huvudsessionen');
});

test('sammanslagning, godkännande och grenskydd görs av en människa', () => {
  const m = PA_GREN('x/2026-01-01');
  assert.ok(bedom(bash('gh pr merge 12 --squash'), m));
  assert.ok(bedom(bash('gh pr review 12 --approve'), m));
  assert.ok(bedom(bash('gh api -X PUT repos/o/r/pulls/12/merge'), m));
  assert.ok(bedom(bash('gh api -X DELETE repos/o/r/branches/main/protection'), m));
  assert.ok(bedom(bash('gh api -X PUT repos/o/r/pulls/12/ccr/auto_merge'), m), 'automatisk sammanslagning');
  assert.ok(bedom(bash('gh api repos/o/r/pulls/12/reviews -f event=APPROVE'), m), 'godkännande via REST');
  assert.ok(bedom(bash('gh api -X PATCH repos/o/r/pulls/12 -f state=closed'), m), 'stänga pull request');
  assert.equal(bedom(bash('gh api repos/o/r/pulls -f title=t -f head=x/2026-01-01 -f base=main -F body=@pr.md'), m), null, 'öppna pull request via REST');
  assert.equal(bedom(bash('gh api repos/o/r/pulls/12/reviews -f event=COMMENT -f body=klar'), m), null);
  assert.equal(bedom(bash('gh api repos/o/r/branches/main/protection'), m), null, 'läsning är tillåten');
  assert.equal(bedom(bash('gh pr create --base main --head x/2026-01-01 --title t --body b'), m), null);
  assert.equal(bedom(bash('gh pr review 12 --comment -b "Granskning klar"'), m), null);
});

test('den riktiga datan skyddas', () => {
  const m = PA_GREN('x');
  assert.ok(bedom(bash('rm data/innehav.db'), m));
  assert.ok(bedom(bash('sqlite3 data/innehav.db "delete from transactions"'), m));
  assert.ok(bedom(bash('INNEHAV_DB=data/innehav.db node server/index.ts'), m));
  assert.ok(bedom(bash('npm run reset -- --ja'), m));
  assert.equal(bedom(bash('ls -la data/'), m), null);
  assert.ok(bedom({ tool_name: 'Write', tool_input: { file_path: '/repo/data/innehav.db', content: '' }, cwd }, m));
  // Agenter får bara starta servern med tillfällig databas
  assert.ok(bedom(bash('node --no-warnings --import tsx server/index.ts &', 'placerare'), m));
  assert.equal(bedom(bash('INNEHAV_DB=$TESTDB PORT=3105 node --no-warnings --import tsx server/index.ts &', 'placerare'), m), null);
  assert.equal(bedom(bash('export INNEHAV_DB=$(mktemp -d)/t.db; PORT=3105 node --import tsx server/index.ts &', 'placerare'), m), null);
});

const FORSLAG_VANTAR = '# Förslag\n\n## Beslut (fylls i av människa)\nStatus: VÄNTAR PÅ GODKÄNNANDE\nGodkänd av: \nDatum: \nKommentar: \n\n## Förslag\n### F1 – Något\n- [ ] Godkänn\n';
const FORSLAG_BESLUTAT = FORSLAG_VANTAR.replace('VÄNTAR PÅ GODKÄNNANDE', 'GODKÄND').replace('Godkänd av: ', 'Godkänd av: Anna Andersson').replace('- [ ] Godkänn', '- [x] Godkänn');

test('agenter får inte fylla i eller ändra beslutet, men huvudsessionen får efter människans svar', () => {
  const fil = '/repo/docs/agentfloden/forbattring/2026-11-15-2-forslag.md';
  const vantar = { aktuellGren: () => 'x', finnsFil: () => FORSLAG_VANTAR };
  const beslutad = { aktuellGren: () => 'x', finnsFil: () => FORSLAG_BESLUTAT };
  const ny = { aktuellGren: () => 'x', finnsFil: () => null };
  const ag = { agent_type: 'senior-utvecklare', agent_id: 'a1' };

  assert.equal(bedom({ tool_name: 'Write', tool_input: { file_path: fil, content: FORSLAG_VANTAR }, cwd, ...ag }, ny), null, 'en ny förslagsfil med orört beslut är tillåten');
  assert.ok(bedom({ tool_name: 'Write', tool_input: { file_path: fil, content: FORSLAG_BESLUTAT }, cwd, ...ag }, ny), 'agenten får inte skriva ett ifyllt beslut');
  assert.ok(bedom({ tool_name: 'Edit', tool_input: { file_path: fil, old_string: 'Status: VÄNTAR PÅ GODKÄNNANDE', new_string: 'Status: GODKÄND' }, cwd, ...ag }, vantar));
  assert.ok(bedom({ tool_name: 'Edit', tool_input: { file_path: fil, old_string: '- [ ] Godkänn', new_string: '- [x] Godkänn' }, cwd, ...ag }, vantar));
  assert.equal(bedom({ tool_name: 'Edit', tool_input: { file_path: fil, old_string: '### F1 – Något', new_string: '### F1 – Något bättre' }, cwd, ...ag }, vantar), null, 'agenten får redigera förslagstexten innan beslut');
  assert.ok(bedom({ tool_name: 'Edit', tool_input: { file_path: fil, old_string: '### F1 – Något', new_string: '### F1 – Annat' }, cwd, ...ag }, beslutad), 'men inte efter beslut');
  assert.ok(bedom(bash(`sed -i 's/VÄNTAR PÅ GODKÄNNANDE/GODKÄND/' ${fil}`, 'implementerare'), vantar));
  assert.equal(bedom(bash(`grep -n Status ${fil}`, 'implementerare'), vantar), null);
  // Huvudsessionen (ingen agent_type) fyller i beslutet efter att människan har svarat
  assert.equal(bedom({ tool_name: 'Edit', tool_input: { file_path: fil, old_string: 'Status: VÄNTAR PÅ GODKÄNNANDE', new_string: 'Status: GODKÄND' }, cwd }, vantar), null);
});

test('agenter får inte ändra spärrarna', () => {
  const m = PA_GREN('x');
  const ag = { agent_type: 'implementerare', agent_id: 'a1' };
  for (const f of ['/repo/.claude/settings.json', '/repo/.claude/hooks/agentvakt.mjs', '/repo/.github/workflows/test.yml', '/repo/scripts/kontrollera-beslut.mjs']) {
    assert.ok(bedom({ tool_name: 'Edit', tool_input: { file_path: f, old_string: 'a', new_string: 'b' }, cwd, ...ag }, m), f);
  }
  assert.ok(bedom(bash('rm .claude/hooks/agentvakt.mjs', 'implementerare'), m));
  assert.equal(bedom(bash('cat .claude/settings.json', 'implementerare'), m), null);
  assert.equal(bedom({ tool_name: 'Edit', tool_input: { file_path: '/repo/server/calc.ts', old_string: 'a', new_string: 'b' }, cwd, ...ag }, m), null);
});

test('hooken svarar med deny-JSON enligt Claude Codes format och släpper igenom annat', () => {
  const kor = (input: unknown) => spawnSync(process.execPath, [vaktFil], { input: JSON.stringify(input), encoding: 'utf8' });
  const stopp = kor({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 1' }, cwd: root });
  assert.equal(stopp.status, 0);
  const svar = JSON.parse(stopp.stdout);
  assert.equal(svar.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(svar.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(svar.hookSpecificOutput.permissionDecisionReason, /människa/);
  const ok = kor({ tool_name: 'Read', tool_input: { file_path: '/x' }, cwd: root });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '');
  const trasig = spawnSync(process.execPath, [vaktFil], { input: 'inte json', encoding: 'utf8' });
  assert.equal(trasig.status, 0, 'vid internt fel släpps anropet igenom');
  assert.match(trasig.stderr, /agentvakt/);
});

test('beslutskontrollen på GitHub kräver ett mänskligt beslut och bara godkända förslag', () => {
  const tva = FORSLAG_BESLUTAT.replace('Status: GODKÄND', 'Status: DELVIS GODKÄND').replace('Datum: ', 'Datum: 2026-11-16') + '\n### F2 – Annat\n- [ ] Godkänn\n';
  const ok = kontrollera({ forslag: tva, commits: ['F1: rättar något', 'Förbättring 2026-11-15 steg 4: leverans'], beslutAndrat: false });
  assert.deepEqual(ok.fel, []);
  assert.deepEqual(ok.godkanda, ['F1']);

  assert.match(kontrollera({ forslag: tva, commits: ['F2: inte godkänd'], beslutAndrat: false }).fel.join(), /gäller F2, som inte är godkänt/);
  assert.match(kontrollera({ forslag: tva, commits: [], beslutAndrat: true }).fel.join(), /ändrad i den här pull requesten/);
  const vantar = kontrollera({ forslag: FORSLAG_VANTAR, commits: ['F1: x'], beslutAndrat: false });
  assert.ok(vantar.fel.some((f) => f.includes('VÄNTAR PÅ GODKÄNNANDE')));
  assert.ok(vantar.fel.some((f) => f.includes('Godkänd av')));
  assert.equal(kontrollera({ forslag: tva, commits: ['Snabbfix'], beslutAndrat: false }).varningar.length, 1);
});

test('beslutskontrollen godkänner det verkliga beslutet för Förbättring 2026-11-15', async () => {
  const { readFileSync } = await import('node:fs');
  const forslag = readFileSync(join(root, 'docs', 'agentfloden', 'forbattring', '2026-11-15-2-forslag.md'), 'utf8');
  const r = kontrollera({ forslag, commits: ['F1: x', 'F12: y'], beslutAndrat: false });
  assert.deepEqual(r.fel, []);
  assert.deepEqual(r.godkanda, ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);
  assert.match(kontrollera({ forslag, commits: ['F13: ej godkänd'], beslutAndrat: false }).fel.join(), /F13/);
});
