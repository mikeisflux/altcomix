import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import { exec, pool } from './db.ts';
import { migrate } from './migrate.ts';
import { clientCountry, clientIp, csrfOk, ensureCsrfCookie, loadSession } from './lib/auth.ts';
import { botGuard } from './lib/botblock.ts';
import { captureError } from './lib/errors.ts';
import { HttpError } from './lib/http.ts';
import { getSetting } from './lib/settings.ts';
import { contentTypeFor, storage } from './lib/storage.ts';

/**
 * Routes live in src/routes/*.ts; each file default-exports
 * `async (app: FastifyInstance) => void` and is loaded automatically.
 * Background work lives in src/jobs/*.ts; each file default-exports a `Job`.
 */
export type Job = { name: string; everyMs: number; run: () => Promise<string | void> };

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.isProd ? 'info' : 'warn' },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 600 * 1024 * 1024, files: 400 } });

  // Keep the raw body for webhook signature checks.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    if (!body.length) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(new HttpError(400, 'Request body is not valid JSON'));
    }
  });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionHash', null);
  app.decorateRequest('clientIp', '');
  app.decorateRequest('country', null);
  app.decorateRequest('showMature', false);

  app.addHook('onRequest', async (req, reply) => {
    req.clientIp = clientIp(req);
    req.country = clientCountry(req);

    const verdict = await botGuard(req);
    if (verdict) return reply.code(verdict.status).send({ error: verdict.error });

    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return;

    await loadSession(req);
    ensureCsrfCookie(req, reply);
    if (!csrfOk(req)) return reply.code(403).send({ error: 'CSRF validation failed' });

    const site = await getSetting('site');
    const staff = req.user?.role === 'admin' || req.user?.role === 'super_admin';
    if (site.maintenance && !staff && !path.startsWith('/api/auth/') && !path.startsWith('/api/admin/') && path !== '/api/bootstrap' && !path.startsWith('/api/health')) {
      return reply.code(503).send({ error: 'NSFWComix is down for maintenance. Back shortly.', code: 'maintenance' });
    }
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { status?: number; statusCode?: number; code?: string };
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message, code: e.code });
    const status = e.statusCode ?? 500;
    if (status === 413) return reply.code(413).send({ error: 'That upload is too large' });
    if (status < 500) return reply.code(status).send({ error: e.message });
    req.log.error(e);
    captureError(e, { source: 'api', endpoint: `${req.method} ${req.routeOptions?.url ?? req.url.split('?')[0]}`, meta: { userId: req.user?.id } });
    return reply.code(500).send({ error: 'Something went wrong on our side. It has been logged.' });
  });

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/') || path.startsWith('/media/')) return reply.code(404).send({ error: 'Not found' });
    // A missing script or stylesheet must be a real 404, never the app's HTML.
    if (path.startsWith('/assets/') || /\.[a-z0-9]{2,5}$/i.test(path)) return reply.code(404).type('text/plain').send('Not found');
    // Single-page app: every other path renders the web client.
    if (existsSync(join(config.webDist, 'index.html'))) return reply.header('cache-control', 'no-cache').type('text/html').sendFile('index.html', config.webDist);
    return reply.code(404).send({ error: 'Web client is not built. Run `npm run build`, or use the Vite dev server.' });
  });

  // Public objects (covers, avatars, free page images) when storage is local or R2 has no public domain.
  app.get('/media/public/*', async (req, reply) => {
    const key = 'public/' + (req.params as { '*': string })['*'];
    const obj = await (await storage()).get(key);
    if (!obj) return reply.code(404).send({ error: 'Not found' });
    reply.header('cache-control', 'public, max-age=31536000, immutable').type(obj.contentType || contentTypeFor(key));
    if (obj.size) reply.header('content-length', obj.size);
    return reply.send(obj.stream);
  });

  const routesDir = join(import.meta.dirname, 'routes');
  // ROUTES=auth,studio limits which route files load (prefix match); handy while developing one area.
  const only = (process.env.ROUTES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const f of (await readdir(routesDir)).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts')).sort()) {
    if (only.length && !only.some((p) => f.startsWith(p))) continue;
    const mod = await import(join(routesDir, f));
    await app.register(mod.default);
  }

  if (existsSync(config.webDist)) {
    // Files are looked up per request, so a new web build is served without restarting the API.
    await app.register(fastifyStatic, { root: config.webDist, wildcard: true, index: false, maxAge: '1h' });
    app.get('/', (_req, reply) => reply.header('cache-control', 'no-cache').type('text/html').sendFile('index.html', config.webDist));
  }

  return app;
}

async function startJobs(log: FastifyInstance['log']): Promise<() => void> {
  const dir = join(import.meta.dirname, 'jobs');
  const timers: NodeJS.Timeout[] = [];
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    const job = (await import(join(dir, f))).default as Job;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      const started = new Date();
      try {
        const detail = await job.run();
        // Only record runs that did something, so the table stays readable.
        if (detail) await exec('insert into cron_runs (job, ok, detail, started_at, finished_at) values ($1,true,$2,$3,now())', [job.name, detail, started]);
      } catch (e) {
        log.error(e, `job ${job.name} failed`);
        captureError(e, { source: 'job', endpoint: job.name });
        await exec('insert into cron_runs (job, ok, detail, started_at, finished_at) values ($1,false,$2,$3,now())', [job.name, (e as Error).message.slice(0, 500), started]).catch(() => {});
      } finally {
        running = false;
      }
    };
    timers.push(setInterval(tick, job.everyMs));
    setTimeout(tick, 3000);
  }
  return () => timers.forEach(clearInterval);
}

if (import.meta.main) {
  await migrate((m) => console.log(m));
  const app = await buildApp();
  const stopJobs = process.env.NO_JOBS ? () => {} : await startJobs(app.log);
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`NSFWComix API listening on :${config.port}`);
  const shutdown = async () => {
    stopJobs();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
