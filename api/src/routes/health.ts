import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one } from '../db.ts';
import { rateLimit } from '../lib/botblock.ts';
import { captureError } from '../lib/errors.ts';
import { HttpError, parse } from '../lib/http.ts';

export default async function healthRoutes(app: FastifyInstance) {
  /** Liveness: the process is up. No dependencies touched. */
  app.get('/api/health/live', async () => ({ ok: true }));

  /** Readiness: the database answers. 503 otherwise, so a load balancer or monitor can act on it. */
  app.get('/api/health', async (_req, reply) => {
    const started = performance.now();
    try {
      await one('select 1');
      return { ok: true, db: true, db_ms: Math.round(performance.now() - started), uptime_s: Math.round(process.uptime()) };
    } catch {
      return reply.code(503).send({ ok: false, db: false, error: 'Database is not reachable' });
    }
  });

  /**
   * Browser error reports from the web client, shown in /admin under Error
   * Logs with source "web". Anonymous, CSRF-exempt and rate limited; nothing
   * from the body is trusted beyond being text.
   */
  app.post('/api/track/error', async (req) => {
    if (!rateLimit('track-error', req.clientIp, 20, 300)) throw new HttpError(429, 'Too many error reports');
    const body = parse(
      z.object({
        message: z.string().trim().min(1).max(2000),
        stack: z.string().max(8000).nullish(),
        url: z.string().max(1000).nullish(),
      }),
      req.body,
    );
    // Group by page path only: query strings can carry tokens.
    let path = '';
    try {
      path = body.url ? new URL(body.url, 'http://local').pathname.slice(0, 200) : '';
    } catch {
      path = '';
    }
    const err = new Error(body.message);
    err.stack = body.stack ?? '';
    captureError(err, {
      source: 'web',
      endpoint: path || undefined,
      meta: { userId: req.user?.id ?? null, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) },
    });
    return { ok: true };
  });
}
