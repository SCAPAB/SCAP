#!/usr/bin/env node
/**
 * Agentvakt – teknisk spärr för agentflödena (PreToolUse-hook i .claude/settings.json).
 *
 * Reglerna i docs/agentfloden/REGLER.md är instruktioner. Den här filen gör de viktigaste
 * av dem till spärrar som gäller oavsett vad en agent har fått för instruktioner:
 *
 * Gäller alla (huvudsessionen och agenter):
 *   1. Ingen push till main. Allt går via en gren och en pull request.
 *   2. Ingen sammanslagning eller godkännande av pull requests och inga ändringar av grenskydd.
 *      Det gör en människa på GitHub.
 *   3. Den riktiga databasen och de uppladdade dokumenten i data/ får inte röras.
 *
 * Gäller agenter (anrop som kommer från en subagent):
 *   4. Beslutsavsnittet i en förslagsfil (*-forslag.md) får inte fyllas i eller ändras.
 *   5. Spärrarna själva (.claude/settings*.json, .claude/hooks/, .github/, scripts/kontrollera-beslut.mjs)
 *      får inte ändras.
 *
 * Spärren läser anropet som JSON på stdin och svarar med permissionDecision "deny" och en
 * förklaring när något stoppas. Vid internt fel släpps anropet igenom och felet skrivs
 * till stderr (spärren är ett skyddsnät, GitHub och granskningen är de slutliga kontrollerna).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRIVANDE = /(^|[^<>&|])>{1,2}(?!&)|\btee\b|\bsed\s+(-\w*\s+)*-i|\bperl\s+(-\w*\s+)*-i|\brm\b|\bmv\b|\bcp\b|\bpython3?\b|\bnode\s+(-\w+\s+)*-e\b|\bchmod\b|\btruncate\b|\bdd\b|\bsqlite3\b/;
const SPARRFILER = /(^|[\s"'=/])(\.claude\/settings(\.local)?\.json|\.claude\/hooks\/|\.github\/|scripts\/kontrollera-beslut\.mjs)/;
const RIKTIG_DATA = /(^|[\s"'=/])data\/(innehav\.db|documents\b)/;
const BESLUTSRAD = /^(Status|Godkänd av|Datum|Kommentar):/m;
const IKRYSSAD = /\[[xX]\]\s*Godkänn/;

/** Delar ett skalkommando i delkommandon (&&, ||, ;, |, radbrytning). Enkel men tillräcklig. */
function delkommandon(cmd) {
  return cmd.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
}

function tokens(s) {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''));
}

/** Avgör om ett delkommando är en git push som hamnar på main. */
function pushTillMain(seg, aktuellGren) {
  const t = tokens(seg);
  const gi = t.findIndex((x) => x === 'git' || x.endsWith('/git'));
  if (gi < 0) return false;
  const pi = t.indexOf('push', gi + 1);
  if (pi < 0) return false;
  const efter = t.slice(pi + 1);
  if (efter.some((x) => x === '--all' || x === '--mirror')) return true;
  // Positionsargument: fjärr + refspecs. Flaggor som tar ett värde (-o, --repo, --push-option) hoppas över.
  const pos = [];
  for (let i = 0; i < efter.length; i++) {
    const x = efter[i];
    if (x.startsWith('-')) {
      if (['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(x)) i++;
      continue;
    }
    pos.push(x);
  }
  const refspecs = pos.slice(1);
  if (refspecs.length === 0) return aktuellGren === 'main';
  return refspecs.some((r) => {
    const mal = r.includes(':') ? r.split(':').pop() : r;
    const namn = mal.replace(/^\+/, '').replace(/^refs\/heads\//, '');
    if (namn === 'main') return true;
    if ((namn === 'HEAD' || namn === '@') && aktuellGren === 'main') return true;
    return false;
  });
}

function sammanslagning(seg) {
  if (/\bgh\s+pr\s+merge\b/.test(seg)) return 'Pull requests slås ihop av en människa på GitHub, inte av en agent.';
  if (/\bgh\s+pr\s+review\b/.test(seg) && /(--approve|\s-a\b)/.test(seg)) return 'Pull requests godkänns av en människa på GitHub, inte av en agent.';
  if (/\bgh\s+api\b/.test(seg) && /\/(merge|merges)\b/.test(seg)) return 'Sammanslagning görs av en människa på GitHub, inte via API:et.';
  if (/\bgh\s+api\b/.test(seg) && /(\/protection|\/rulesets)\b/.test(seg) && !/^gh\s+api\s+(-X\s+GET\s+)?\S+$/.test(seg.trim())) return 'Grenskyddet ändras bara av en människa.';
  return null;
}

function beslutsavsnitt(text) {
  const m = text.match(/## Beslut[^\n]*\n([\s\S]*?)(?=\n## |$)/);
  return m ? m[1].trim() : '';
}

function orortBeslut(text) {
  const b = beslutsavsnitt(text);
  if (!b) return true;
  return /Status:\s*VÄNTAR PÅ GODKÄNNANDE/.test(b) && /Godkänd av:[ \t]*$/m.test(b) && !IKRYSSAD.test(text);
}

/**
 * Bedömer ett verktygsanrop. Returnerar null om det är tillåtet, annars en förklaring.
 * @param {any} input hookens JSON-indata
 * @param {{ aktuellGren?: () => string, finnsFil?: (p: string) => string | null }} miljo
 */
export function bedom(input, miljo = {}) {
  const verktyg = input.tool_name;
  const ti = input.tool_input ?? {};
  const agent = input.agent_type || input.agent_id ? (input.agent_type || 'agent') : null;
  const cwd = input.cwd || process.cwd();
  let gren;
  const aktuellGren = () => (gren ??= (miljo.aktuellGren ?? (() => execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()))());
  const lasFil = miljo.finnsFil ?? ((p) => (existsSync(p) ? readFileSync(p, 'utf8') : null));

  if (verktyg === 'Bash') {
    const cmd = String(ti.command ?? '');
    for (const seg of delkommandon(cmd)) {
      if (pushTillMain(seg, aktuellGren())) return 'Push till main är spärrad. Pusha till en egen gren och öppna en pull request – en människa för in ändringen i main.';
      const s = sammanslagning(seg);
      if (s) return s;
    }
    if (RIKTIG_DATA.test(cmd) && (SKRIVANDE.test(cmd) || /INNEHAV_DB=\S*data\/innehav\.db/.test(cmd))) return 'Den riktiga databasen och dokumenten i data/ får inte röras. Använd en tillfällig databas (INNEHAV_DB=$(mktemp -d)/test.db).';
    if (/\bnpm\s+run\s+reset\b|server\/reset\.ts/.test(cmd)) return 'Återställning av databasen är spärrad i agentflödena. Kör den själv i en terminal om det verkligen är meningen.';
    if (agent) {
      // Servern använder data/innehav.db om INNEHAV_DB saknas – agenter måste alltid ange en tillfällig databas.
      for (const seg of delkommandon(cmd)) {
        const startar = /server\/index\.ts\b|\bnpm\s+(run\s+)?(dev|start|dev:api)\b/.test(seg);
        if (startar && !/\bINNEHAV_DB=/.test(seg) && !/\bINNEHAV_DB=/.test(cmd)) return `Agenten ${agent} får bara starta servern med en tillfällig databas: INNEHAV_DB=$(mktemp -d)/test.db PORT=31xx node --no-warnings --import tsx server/index.ts`;
      }
      if (/-forslag\.md/.test(cmd) && SKRIVANDE.test(cmd)) return `Agenten ${agent} får inte ändra förslagsfiler via skalet. Beslutet fylls i av en människa.`;
      if (SPARRFILER.test(cmd) && SKRIVANDE.test(cmd)) return `Agenten ${agent} får inte ändra spärrarna (.claude/settings, .claude/hooks, .github, scripts/kontrollera-beslut.mjs).`;
    }
    return null;
  }

  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(verktyg)) {
    const fil = String(ti.file_path ?? ti.notebook_path ?? '');
    const abs = resolve(cwd, fil);
    const rel = abs.startsWith(cwd + '/') ? abs.slice(cwd.length + 1) : fil;
    if (/^data\//.test(rel) || /\/data\/(innehav\.db|documents\/)/.test(abs)) return 'Den riktiga datan i data/ får inte ändras av agentflödena.';
    if (!agent) return null;
    if (SPARRFILER.test(rel) || SPARRFILER.test(abs)) return `Agenten ${agent} får inte ändra spärrarna (.claude/settings, .claude/hooks, .github, scripts/kontrollera-beslut.mjs).`;
    if (/-forslag\.md$/.test(abs)) {
      const nu = lasFil(abs);
      if (verktyg === 'Write') {
        if (nu !== null && !orortBeslut(nu)) return `Förslagsfilen har redan ett mänskligt beslut och får inte skrivas om av agenten ${agent}.`;
        if (!orortBeslut(String(ti.content ?? ''))) return `Agenten ${agent} får bara skriva förslagsfilen med beslutet orört (Status: VÄNTAR PÅ GODKÄNNANDE, tom "Godkänd av", inga [x]).`;
        return null;
      }
      const delar = verktyg === 'MultiEdit' ? (ti.edits ?? []) : [ti];
      for (const d of delar) {
        const gammal = String(d.old_string ?? ''), ny = String(d.new_string ?? '');
        if (BESLUTSRAD.test(gammal) || BESLUTSRAD.test(ny) || IKRYSSAD.test(ny) || /Godkänn/.test(gammal)) {
          return `Agenten ${agent} får inte ändra beslutsavsnittet eller kryssrutorna i en förslagsfil. Det gör en människa.`;
        }
      }
      if (nu !== null && !orortBeslut(nu)) return `Förslagsfilen har redan ett mänskligt beslut och får inte ändras av agenten ${agent}.`;
    }
  }
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let skal = null;
  try {
    skal = bedom(JSON.parse(raw));
  } catch (e) {
    process.stderr.write(`agentvakt: kunde inte bedöma anropet (${e.message}). Släpps igenom.\n`);
    return;
  }
  if (skal) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Agentvakt: ${skal}` } }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
