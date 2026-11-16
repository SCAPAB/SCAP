/**
 * Raderar ALL data i databasen och de uppladdade dokumenten. Kräver --ja.
 *   npm run reset -- --ja
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { db, DB_PATH } from './db.ts';
import { ensureSetup } from './setup.ts';

if (!process.argv.includes('--ja')) {
  console.error('Detta raderar all data. Kör: npm run reset -- --ja');
  process.exit(1);
}
const tables = ['change_requests', 'ms_sync_log', 'aliases', 'policy_targets', 'settings', 'proposals', 'extraction_rules', 'audit_log', 'sessions', 'transactions',
  'documents', 'prices', 'pe_valuations', 'fx_rates', 'instruments', 'entities', 'users'];
db.exec('BEGIN');
for (const t of tables) db.exec(`DELETE FROM ${t}`);
db.exec('COMMIT');
rmSync(join(dirname(DB_PATH), 'documents'), { recursive: true, force: true });
ensureSetup();
console.log('All data raderad. Programmet är tomt.');
