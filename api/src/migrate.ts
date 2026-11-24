import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool } from './db.ts';

const LOCK = 727274;

export async function migrate(log: (m: string) => void = console.log): Promise<void> {
  const dir = join(import.meta.dirname, 'migrations');
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK]);
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [f]);
        await client.query('commit');
        log(`migrated ${f}`);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    client.release();
  }
}

if (import.meta.main) {
  await migrate();
  await pool.end();
}
