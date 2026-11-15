/**
 * Grundinställning av en tom installation. Körs automatiskt när servern startar och är
 * idempotent: den skapar bara det som saknas och rör aldrig befintlig data.
 *  - en administratör (ADMIN_EMAIL / ADMIN_PASSWORD)
 *  - den juridiska enhet som förvaltas (ORG_NAME / ORG_NR)
 *
 * Inga instrument, kurser eller transaktioner skapas – programmet startar tomt.
 */
import bcrypt from 'bcryptjs';
import { get, run } from './db.ts';

export function ensureSetup() {
  if (!get('SELECT 1 FROM users LIMIT 1')) {
    const email = process.env.ADMIN_EMAIL ?? 'admin@innehav.local';
    const pw = process.env.ADMIN_PASSWORD ?? 'innehav';
    run('INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)', email, 'Administratör', bcrypt.hashSync(pw, 10), 'admin');
    console.log(`Skapade administratör ${email}${process.env.ADMIN_PASSWORD ? '' : ' med lösenordet "innehav" – byt det under Administration → Användare'}`);
  }
  if (!get('SELECT 1 FROM entities LIMIT 1')) {
    run('INSERT INTO entities (id, name, org_nr) VALUES (1, ?, ?)', process.env.ORG_NAME ?? 'Lantbrukarnas Ekonomi AB', process.env.ORG_NR ?? null);
  }
}

// Körs direkt: npm run setup
if (process.argv[1]?.endsWith('setup.ts')) {
  ensureSetup();
  console.log('Klart.');
}
