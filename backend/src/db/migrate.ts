import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { loadConfig, type Config } from '../config/env.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

async function connect(config: Config) {
  return mysql.createConnection({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    multipleStatements: true,
    timezone: 'Z',
  });
}

async function listMigrations(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files
    .filter((f) => f.endsWith('.up.sql'))
    .map((f) => f.replace(/\.up\.sql$/, ''))
    .sort();
}

export async function migrateUp(config: Config, log: (m: string) => void = console.log): Promise<string[]> {
  const conn = await connect(config);
  const applied: string[] = [];
  try {
    await conn.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(100) NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB',
    );
    // Serialize concurrent migration runs.
    const [[lock]] = (await conn.query("SELECT GET_LOCK('arthvex_migrations', 30) AS l")) as unknown as [[{ l: number }]];
    if (lock.l !== 1) throw new Error('Could not obtain migration lock');
    const [done] = (await conn.query('SELECT version FROM schema_migrations')) as unknown as [{ version: string }[]];
    const doneSet = new Set(done.map((r) => r.version));
    for (const version of await listMigrations()) {
      if (doneSet.has(version)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, `${version}.up.sql`), 'utf8');
      log(`Applying ${version}`);
      // MySQL DDL is not transactional; a failed migration must be repaired manually (see docs/database.md).
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
      applied.push(version);
    }
    await conn.query("SELECT RELEASE_LOCK('arthvex_migrations')");
  } finally {
    await conn.end();
  }
  return applied;
}

export async function migrateDown(config: Config, log: (m: string) => void = console.log): Promise<string | null> {
  const conn = await connect(config);
  try {
    await conn.query('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(100) NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB');
    const [done] = (await conn.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')) as unknown as [{ version: string }[]];
    const last = done[0]?.version;
    if (!last) return null;
    const sql = await readFile(join(MIGRATIONS_DIR, `${last}.down.sql`), 'utf8');
    log(`Rolling back ${last}`);
    await conn.query(sql);
    await conn.query('DELETE FROM schema_migrations WHERE version = ?', [last]);
    return last;
  } finally {
    await conn.end();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  const cmd = process.argv[2] ?? 'up';
  if (cmd === 'down' && config.isProduction && process.env.CONFIRM_ROLLBACK !== 'yes') {
    console.error('Refusing to roll back in production without CONFIRM_ROLLBACK=yes. Take a verified backup first.');
    process.exit(1);
  }
  const run = cmd === 'down' ? migrateDown(config).then((v) => console.log(v ? `Rolled back ${v}` : 'Nothing to roll back')) : migrateUp(config).then((a) => console.log(a.length ? `Applied ${a.length} migration(s)` : 'Database is up to date'));
  run.catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
