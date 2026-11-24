import { appendFile } from 'node:fs/promises';
import type { FastifyRequest } from 'fastify';
import { exec, one, q } from '../db.ts';
import { alertAdmins } from './email.ts';
import { getSetting } from './settings.ts';

/**
 * Bot blocker, ported from IndieCrowdfund's proxy. Rule based, no scoring:
 *
 *   1. trusted crawlers (search + social previews) skip every check
 *   2. blocked IPs get a 403 (signed-in users are never IP-blocked)
 *   3. scanner probes (/.env, /wp-admin, *.php ...) are blocked on first hit
 *   4. anonymous clients walking many distinct record ids are blocked
 *   5. anonymous clients over the per-minute request limit get a 429 (no ban)
 *
 * Blocks are stored in `blocked_ips` with escalating durations and appended to
 * /tmp/botblock-pending, which scripts/botblock/botblock-watcher.sh turns into
 * iptables DROP rules within seconds.
 */

const PENDING_FILE = '/tmp/botblock-pending';
const SYNC_MS = 60_000;
const DAY = 86_400_000;

const SEARCH_CRAWLER_UA = [
  'googlebot', 'adsbot-google', 'mediapartners-google', 'google-inspectiontool', 'googleother', 'apis-google',
  'google-site-verification', 'google-structured-data-testing-tool', 'google page speed', 'google favicon',
  'googleweblight', 'google-read-aloud', 'google-pagerenderer', 'pagespeed', 'lighthouse', 'chrome-lighthouse',
];
// Google crawl ranges. The source also allowed all of 34.* and 35.* (Google Cloud), which lets any
// rented VM pose as Googlebot, so those are left out here.
const GOOGLE_IP_PREFIXES = ['66.249.', '64.233.', '72.14.', '74.125.', '142.250.', '172.253.', '209.85.', '216.58.', '216.239.'];
const SOCIAL_CRAWLER_UA = [
  'facebookexternalhit', 'facebookcatalog', 'facebookbot', 'facebot', 'meta-externalagent', 'meta-externalfetcher',
  'whatsapp', 'instagram', 'twitterbot', 'linkedinbot', 'pinterest', 'pinterestbot', 'redditbot', 'slackbot',
  'slack-imgproxy', 'discordbot', 'telegrambot', 'bingbot', 'bingpreview', 'adidxbot', 'msnbot', 'duckduckbot',
  'duckduckgo-favicons-bot', 'applebot', 'yandexbot', 'yandeximages', 'baiduspider', 'embedly', 'iframely', 'vkshare',
  'w3c_validator', 'tumblr', 'bitlybot', 'skypeuripreview', 'outbrain', 'quora link preview', 'yahoo! slurp',
  'yahoo link preview', 'bsky', 'mastodon',
];

const SCANNER_PREFIXES = [
  '/.env', '/wp-admin', '/wp-login', '/wp-content', '/xmlrpc.php', '/admin.php', '/phpmyadmin', '/actuator',
  '/config.json', '/.git', '/cgi-bin', '/_next/', '/_rsc', '/_react',
];
const SCANNER_PATTERN =
  /\.(php[0-9]?|phtml|asp|aspx|ashx|jsp|jspx|cgi|pl|cfm)$|^\/(vendor|wp-includes|wp-json|administrator|joomla|typo3|magento|owa|autodiscover|solr|jenkins|manager\/html|\.aws|\.ssh|\.svn|\.hg|\.DS_Store|server-status|telescope|_ignition|\.well-known\/(?!security\.txt|change-password|assetlinks\.json|apple-app-site-association))/i;

const RECORD_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4,})$/i;
const ENUM_WINDOW_MS = 10 * 60_000;
const ENUM_LIMIT_ANON = 150;

const blocked = new Map<string, number>(); // ip -> expiry ms
const rate = new Map<string, { n: number; reset: number }>();
const enumeration = new Map<string, { ids: Set<string>; reset: number }>();
let lastSync = 0;
let syncing: Promise<void> | null = null;

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'unknown';
}

export function isTrustedCrawler(ip: string, ua: string): boolean {
  const u = ua.toLowerCase();
  if (SOCIAL_CRAWLER_UA.some((p) => u.includes(p))) return true;
  return SEARCH_CRAWLER_UA.some((p) => u.includes(p)) && GOOGLE_IP_PREFIXES.some((p) => ip.startsWith(p));
}

export function isScannerPath(path: string): boolean {
  return SCANNER_PREFIXES.some((p) => path.startsWith(p)) || SCANNER_PATTERN.test(path);
}

async function sync(): Promise<void> {
  const rows = await q<{ ip_address: string; expires_at: string }>('select ip_address, expires_at from blocked_ips where expires_at > now()');
  blocked.clear();
  for (const r of rows) blocked.set(r.ip_address, Date.parse(r.expires_at));
  lastSync = Date.now();
}

/** Drop an IP from this worker's cache (other workers pick it up on their next sync). */
export function forgetBlockedIp(ip: string): void {
  blocked.delete(ip);
  lastSync = 0;
}

/**
 * Record a violation. With `block`, the IP is blocked for 24h, 72h, 7d, 30d,
 * then permanently, by how many times it has been blocked before.
 */
export async function reportIp(
  ip: string,
  reason: string,
  opts: { path?: string; userAgent?: string; block?: boolean; alert?: boolean } = {},
): Promise<void> {
  if (isLoopback(ip)) return;
  await exec('insert into suspicious_activity (ip_address, reason, path, user_agent) values ($1,$2,$3,$4)', [
    ip, reason, opts.path?.slice(0, 500) ?? null, opts.userAgent?.slice(0, 300) ?? null,
  ]);
  if (opts.block) {
    const prev = await one<{ violation_count: number }>('select violation_count from blocked_ips where ip_address = $1', [ip]);
    const violations = (prev?.violation_count ?? 0) + 1;
    const hours = violations <= 1 ? 24 : violations === 2 ? 72 : violations === 3 ? 168 : 720;
    const expires = violations >= 5 ? new Date('9999-12-31T00:00:00Z') : new Date(Date.now() + hours * 3_600_000);
    await exec(
      `insert into blocked_ips (ip_address, reason, violation_count, expires_at, last_user_agent, last_path)
       values ($1,$2,1,$3,$4,$5)
       on conflict (ip_address) do update set reason = excluded.reason, violation_count = blocked_ips.violation_count + 1,
         blocked_at = now(), expires_at = excluded.expires_at, last_user_agent = excluded.last_user_agent,
         last_path = excluded.last_path, updated_at = now()`,
      [ip, reason, expires, opts.userAgent?.slice(0, 300) ?? null, opts.path?.slice(0, 500) ?? null],
    );
    blocked.set(ip, expires.getTime());
    // Contract with the firewall watcher: one IP per line.
    await appendFile(PENDING_FILE, ip + '\n').catch(() => {});
  }
  if (opts.alert) await alertAdmins(`Security: ${reason}`, `IP ${ip} — ${reason}${opts.path ? ` at ${opts.path}` : ''}`).catch(() => {});
}

export type BotVerdict = { status: 403 | 429; error: string } | null;

/** Called for every request before routing. Returns a verdict to short-circuit, or null to continue. */
export async function botGuard(req: FastifyRequest): Promise<BotVerdict> {
  const security = await getSetting('security');
  if (!security.bot_blocker_enabled) return null;

  const ip = req.clientIp;
  const ua = String(req.headers['user-agent'] ?? '');
  const path = req.url.split('?')[0];
  const now = Date.now();

  if (now - lastSync > SYNC_MS) {
    syncing ??= sync().catch(() => {}).finally(() => (syncing = null));
    if (lastSync === 0) await syncing;
  }

  if (isTrustedCrawler(ip, ua)) return null;

  const signedIn = Boolean(req.cookies?.session_token);

  if (!signedIn) {
    const until = blocked.get(ip);
    if (until && until > now) return { status: 403, error: 'Forbidden' };
    if (until) blocked.delete(ip);
  }

  if (isScannerPath(path)) {
    if (!isLoopback(ip)) {
      blocked.set(ip, now + 7 * DAY);
      reportIp(ip, `Scanner probe: ${path.slice(0, 120)}`, { path, userAgent: ua, block: true }).catch(() => {});
    }
    return { status: 403, error: 'Forbidden' };
  }

  if (signedIn || isLoopback(ip)) return null;

  // Record enumeration: many distinct ids under /api from one anonymous client.
  if (path.startsWith('/api/')) {
    const segs = path.split('/');
    for (let i = 3; i < segs.length; i++) {
      if (!RECORD_ID.test(segs[i])) continue;
      let e = enumeration.get(ip);
      if (!e || e.reset < now) {
        e = { ids: new Set(), reset: now + ENUM_WINDOW_MS };
        enumeration.set(ip, e);
      }
      e.ids.add(`${segs[i - 1]}:${segs[i]}`);
      if (e.ids.size >= ENUM_LIMIT_ANON) {
        enumeration.delete(ip);
        blocked.set(ip, now + 3_600_000);
        reportIp(ip, `Record enumeration: ${ENUM_LIMIT_ANON} distinct records in 10 minutes`, { path, userAgent: ua, block: true, alert: true }).catch(() => {});
        return { status: 403, error: 'Forbidden' };
      }
    }
  }

  // Fixed-window rate limit. Page images are excluded: one issue is dozens of requests.
  // So are provider webhooks: they authenticate themselves (signature or secret address), a
  // provider delivers a burst of mail or events from a handful of addresses, and a 429 makes it retry.
  if (!path.startsWith('/media/') && !path.startsWith('/assets/') && !path.startsWith('/api/webhooks/')) {
    let r = rate.get(ip);
    if (!r || r.reset < now) {
      r = { n: 0, reset: now + 60_000 };
      rate.set(ip, r);
    }
    if (++r.n > security.rate_limit_per_minute) return { status: 429, error: 'Too many requests. Slow down and try again in a minute.' };
  }

  if (rate.size > 50_000) rate.clear();
  if (enumeration.size > 20_000) enumeration.clear();
  return null;
}

/** Small per-key limiter for sensitive endpoints (login, register, redeem ...). */
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(namespace: string, key: string, limit: number, windowSec: number): boolean {
  const k = `${namespace}:${key}`;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || b.reset < now) {
    b = { n: 0, reset: now + windowSec * 1000 };
    buckets.set(k, b);
  }
  if (buckets.size > 100_000) buckets.clear();
  return ++b.n <= limit;
}
