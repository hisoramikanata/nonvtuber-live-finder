import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');

export async function runMigrations() {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = [];
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`[migrate] applying ${file}`);
    await pool.query(sql);
    applied.push(file);
  }

  console.log('[migrate] done');
  return { applied };
}

// `node src/migrate.js` で直接実行された場合のみCLIとして動く
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[migrate] failed', err);
      process.exit(1);
    });
}
