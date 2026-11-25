import { exec } from '../db.ts';
import { sha256 } from './crypto.ts';

/**
 * Self-hosted error tracking. Errors are grouped by a fingerprint of
 * source + endpoint + message with ids and numbers stripped, and shown in
 * /admin under Error Logs.
 */
const recent = new Map<string, { n: number; at: number }>();

function normalize(msg: string): string {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .slice(0, 300);
}

export function captureError(
  err: unknown,
  ctx: { source: 'api' | 'web' | 'job'; endpoint?: string; level?: 'error' | 'warning'; meta?: Record<string, unknown> },
): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const fingerprint = sha256(`${ctx.source}:${ctx.endpoint ?? ''}:${normalize(e.message)}`);
  const now = Date.now();
  const seen = recent.get(fingerprint);
  // At most 3 writes per fingerprint per 5 seconds.
  if (seen && now - seen.at < 5000) {
    if (seen.n >= 3) return;
    seen.n++;
  } else {
    recent.set(fingerprint, { n: 1, at: now });
    if (recent.size > 2000) recent.clear();
  }
  exec(
    `insert into error_groups (fingerprint, title, source, endpoint, level, last_message, last_stack, last_meta)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (fingerprint) do update set
       event_count = error_groups.event_count + 1, last_seen = now(), last_message = excluded.last_message,
       last_stack = excluded.last_stack, last_meta = excluded.last_meta,
       status = case when error_groups.status = 'resolved' then 'unresolved' else error_groups.status end`,
    [fingerprint, e.message.slice(0, 200), ctx.source, ctx.endpoint ?? null, ctx.level ?? 'error', e.message.slice(0, 2000),
     (e.stack ?? '').slice(0, 8000), JSON.stringify(ctx.meta ?? {})],
  ).catch(() => {});
}
