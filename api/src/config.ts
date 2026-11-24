import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function required(name: string, devDefault?: string): string {
  const v = env[name];
  if (v) return v;
  if (!isProd && devDefault !== undefined) return devDefault;
  throw new Error(`Missing required environment variable ${name}`);
}

const databaseUrl = required('DATABASE_URL', 'postgres://postgres@127.0.0.1:5433/nsfwcomix');

export const config = {
  isProd,
  port: Number(env.PORT ?? 4000),
  appUrl: (env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  databaseUrl,
  // Development falls back to a stable machine-local value so saved settings survive restarts.
  appSecret: required('APP_SECRET', createHash('sha256').update(`dev:${databaseUrl}`).digest('base64')),
  storageDir: resolve(env.STORAGE_DIR ?? resolve(import.meta.dirname, '../../storage')),
  superAdminEmail: (env.SUPER_ADMIN_EMAIL ?? '').toLowerCase(),
  cronSecret: env.CRON_SECRET ?? '',
  webDist: resolve(import.meta.dirname, '../../web/dist'),
};
