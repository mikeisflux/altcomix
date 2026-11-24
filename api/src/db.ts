import pg from 'pg';
import { config } from './config.ts';

// int8 and numeric as JS numbers; dates stay 'YYYY-MM-DD'.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export type Queryable = { query: (text: string, params?: unknown[]) => Promise<pg.QueryResult<Row>> };

export async function q<T extends Row = Row>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T[]> {
  const r = await db.query(text, params);
  return r.rows as T[];
}

export async function one<T extends Row = Row>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T | null> {
  const r = await db.query(text, params);
  return (r.rows[0] as T) ?? null;
}

export async function exec(text: string, params: unknown[] = [], db: Queryable = pool): Promise<number> {
  const r = await db.query(text, params);
  return r.rowCount ?? 0;
}

export async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Build "col = $n" fragments for a partial update from a whitelist of columns.
 * Plain objects are sent as JSON (for jsonb columns); arrays are sent as-is (for text[]).
 */
export function patch(body: Row, columns: string[], startAt = 1): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const c of columns) {
    const v = body[c];
    if (v === undefined) continue;
    values.push(v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v);
    sets.push(`${c} = $${startAt + values.length - 1}`);
  }
  return { sets, values };
}
