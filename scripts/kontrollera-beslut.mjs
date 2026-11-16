#!/usr/bin/env node
/**
 * Beslutskontroll för pull requests från agentflöden. Körs på GitHub (.github/workflows/test.yml).
 *
 * En gren som heter <flöde>/<ÅÅÅÅ-MM-DD> och hör till ett flöde i docs/agentfloden/<flöde>/
 * måste ha ett mänskligt beslut i docs/agentfloden/<flöde>/<datum>-*-forslag.md:
 *   - Status GODKÄND eller DELVIS GODKÄND, och "Godkänd av" och "Datum" ifyllda.
 *   - Varje commit vars rubrik börjar med ett förslags-id ("F3: …") gäller ett ikryssat förslag.
 *   - Beslutet får inte ändras i pull requesten. Det ska finnas på main innan bygget börjar.
 * Grenar som inte hör till ett agentflöde släpps igenom.
 *
 * Användning: node scripts/kontrollera-beslut.mjs [gren] [basgren]
 * (standard: $GITHUB_HEAD_REF och $GITHUB_BASE_REF, annars aktuell gren och main)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ren kontroll utan git och filsystem, så att den går att testa.
 * @param {{ forslag: string, commits: string[], beslutAndrat: boolean }} p
 * @returns {{ fel: string[], varningar: string[], godkanda: string[] }}
 */
export function kontrollera({ forslag, commits, beslutAndrat }) {
  const fel = [], varningar = [];
  const beslut = (forslag.match(/## Beslut[^\n]*\n([\s\S]*?)(?=\n## |$)/) ?? [])[1] ?? '';
  const falt = (namn) => (beslut.match(new RegExp(`^${namn}:[ \\t]*(.*)$`, 'm')) ?? [])[1]?.trim() ?? '';
  const status = falt('Status');
  if (!/^(GODKÄND|DELVIS GODKÄND)$/.test(status)) fel.push(`Beslutet har status "${status || 'saknas'}". Det måste vara GODKÄND eller DELVIS GODKÄND.`);
  if (!falt('Godkänd av')) fel.push('"Godkänd av" är inte ifyllt.');
  if (!falt('Datum')) fel.push('"Datum" i beslutet är inte ifyllt.');
  if (beslutAndrat) fel.push('Förslagsfilen är ändrad i den här pull requesten. Beslutet ska fattas och commit:as på main innan bygget börjar.');

  const godkanda = [];
  for (const m of forslag.matchAll(/^###\s+(F\d+)\b[^\n]*\n(?:(?!###)[^\n]*\n)*?-\s*\[([ xX])\]\s*Godkänn/gm)) {
    if (m[2].toLowerCase() === 'x') godkanda.push(m[1]);
  }
  if (!fel.length && godkanda.length === 0) fel.push('Inget förslag är ikryssat som godkänt.');

  for (const rubrik of commits) {
    const id = (rubrik.match(/^(F\d+)\b/) ?? [])[1];
    if (id && !godkanda.includes(id)) fel.push(`Commit "${rubrik}" gäller ${id}, som inte är godkänt.`);
    if (!id && !/^(Förbättring|Leverans|Granskning|Merge)\b/.test(rubrik)) varningar.push(`Commit "${rubrik}" börjar inte med ett förslags-id. Granska den särskilt.`);
  }
  return { fel, varningar, godkanda };
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function main() {
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  const gren = process.argv[2] || process.env.GITHUB_HEAD_REF || git('rev-parse', '--abbrev-ref', 'HEAD');
  const bas = process.argv[3] || process.env.GITHUB_BASE_REF || 'main';
  const m = gren.match(/^([a-z0-9-]+)\/(\d{4}-\d{2}-\d{2})/);
  const flodeDir = m && join(root, 'docs', 'agentfloden', m[1]);
  if (!m || !existsSync(flodeDir)) {
    console.log(`Grenen "${gren}" hör inte till något agentflöde. Ingen beslutskontroll behövs.`);
    return;
  }
  const fil = readdirSync(flodeDir).find((f) => f.startsWith(m[2]) && f.endsWith('-forslag.md'));
  if (!fil) {
    console.error(`::error::Grenen "${gren}" hör till flödet ${m[1]}, men docs/agentfloden/${m[1]}/${m[2]}-*-forslag.md saknas.`);
    process.exit(1);
  }
  const relFil = `docs/agentfloden/${m[1]}/${fil}`;
  const basRef = git('rev-parse', '--verify', '--quiet', `origin/${bas}`) ? `origin/${bas}` : bas;
  const commits = git('log', '--no-merges', '--format=%s', `${basRef}..HEAD`).split('\n').filter(Boolean);
  const beslutAndrat = git('diff', '--name-only', `${basRef}...HEAD`, '--', relFil) !== '';
  const r = kontrollera({ forslag: readFileSync(join(root, relFil), 'utf8'), commits, beslutAndrat });

  console.log(`Beslut: ${relFil}`);
  console.log(`Godkända förslag: ${r.godkanda.join(', ') || 'inga'}`);
  console.log(`Commits i pull requesten: ${commits.length}`);
  for (const v of r.varningar) console.log(`::warning::${v}`);
  for (const f of r.fel) console.error(`::error::${f}`);
  if (r.fel.length) process.exit(1);
  console.log('Beslutskontrollen är godkänd.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
