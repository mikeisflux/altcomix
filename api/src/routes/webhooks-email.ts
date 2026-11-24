import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { exec } from '../db.ts';
import { isUuid } from '../lib/admin.ts';
import { suppress } from '../lib/email.ts';
import { HttpError } from '../lib/http.ts';
import { getSetting } from '../lib/settings.ts';

/**
 * Delivery events from the email provider. Both endpoints verify the
 * provider's signature and refuse everything when no verification key is
 * saved in /admin (fail closed). Events are matched to a row in `emails` by
 * the id lib/email.ts attaches to every message: SendGrid custom arg
 * `email_id`, Mailgun user variable `email_id`.
 */

type Kind = 'delivered' | 'open' | 'click' | 'bounce' | 'dropped' | 'spam' | 'unsubscribe' | 'ignored';
type Event = { kind: Kind; emailId: string | null; address: string | null; at: Date; reason: string; provider: 'sendgrid' | 'mailgun' };

const rawBody = (req: FastifyRequest): Buffer => (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);

async function apply(e: Event): Promise<void> {
  const id = e.emailId;
  const address = e.address?.trim().toLowerCase() || null;
  switch (e.kind) {
    case 'delivered':
      if (id) await exec(`update emails set status = 'sent', sent_at = coalesce(sent_at, $2), error = null where id = $1 and status in ('sending','queued','sent')`, [id, e.at]);
      break;
    case 'open':
      if (id) await exec('update emails set opened_at = coalesce(opened_at, $2) where id = $1', [id, e.at]);
      break;
    case 'click':
      if (id) await exec('update emails set clicked_at = coalesce(clicked_at, $2), opened_at = coalesce(opened_at, $2) where id = $1', [id, e.at]);
      break;
    case 'bounce':
      if (id) await exec(`update emails set status = 'failed', error = $2 where id = $1`, [id, `Bounced: ${e.reason}`.slice(0, 500)]);
      if (address) await suppress(address, `Hard bounce: ${e.reason}`.slice(0, 300), e.provider);
      break;
    case 'dropped':
      if (id) await exec(`update emails set status = 'failed', error = $2 where id = $1 and status <> 'failed'`, [id, `Dropped by ${e.provider}: ${e.reason}`.slice(0, 500)]);
      break;
    case 'spam':
      if (address) {
        await suppress(address, 'Marked as spam by the recipient', e.provider);
        await exec('update users set email_unsubscribed_at = coalesce(email_unsubscribed_at, now()) where lower(email) = $1', [address]);
      }
      break;
    case 'unsubscribe':
      // Stops notification and marketing mail; receipts and account mail still go out.
      if (address) await exec('update users set email_unsubscribed_at = coalesce(email_unsubscribed_at, now()) where lower(email) = $1', [address]);
      break;
    default:
  }
}

async function applyAll(events: Event[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    await apply(e);
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  return counts;
}

/** SendGrid signs `timestamp + raw body` with ECDSA P-256 / SHA-256; the key is base64 DER (SPKI). */
function sendgridSignatureOk(publicKey: string, signature: string, timestamp: string, body: Buffer): boolean {
  try {
    const pem = publicKey.includes('BEGIN') ? publicKey : null;
    const key = pem ? createPublicKey(pem) : createPublicKey({ key: Buffer.from(publicKey.replace(/\s/g, ''), 'base64'), format: 'der', type: 'spki' });
    return verify('sha256', Buffer.concat([Buffer.from(timestamp, 'utf8'), body]), { key, dsaEncoding: 'der' }, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

const SENDGRID: Record<string, Kind> = {
  delivered: 'delivered', open: 'open', click: 'click', dropped: 'dropped', spamreport: 'spam', unsubscribe: 'unsubscribe', group_unsubscribe: 'unsubscribe',
};
const MAILGUN: Record<string, Kind> = { delivered: 'delivered', opened: 'open', clicked: 'click', complained: 'spam', unsubscribed: 'unsubscribe' };

export default async function emailWebhookRoutes(app: FastifyInstance) {
  app.post('/api/webhooks/email/sendgrid', async (req) => {
    const key = (await getSetting('email')).sendgrid_webhook_key;
    if (!key) throw new HttpError(503, 'SendGrid webhook verification key is not configured');
    const signature = req.headers['x-twilio-email-event-webhook-signature'];
    const timestamp = req.headers['x-twilio-email-event-webhook-timestamp'];
    if (typeof signature !== 'string' || typeof timestamp !== 'string' || !sendgridSignatureOk(key, signature, timestamp, rawBody(req))) {
      throw new HttpError(401, 'Invalid webhook signature');
    }
    const list = Array.isArray(req.body) ? (req.body as Record<string, unknown>[]) : [];
    const events: Event[] = list.slice(0, 5000).map((ev) => {
      const name = String(ev.event ?? '');
      // "blocked" bounces are temporary refusals by the receiving server, not dead addresses.
      const kind: Kind = name === 'bounce' ? (ev.type === 'blocked' ? 'ignored' : 'bounce') : (SENDGRID[name] ?? 'ignored');
      const emailId = typeof ev.email_id === 'string' && isUuid(ev.email_id) ? ev.email_id : null;
      return {
        kind,
        emailId,
        address: typeof ev.email === 'string' ? ev.email : null,
        at: new Date((Number(ev.timestamp) || Date.now() / 1000) * 1000),
        reason: String(ev.reason ?? ev.response ?? ev.status ?? name).slice(0, 300),
        provider: 'sendgrid',
      };
    });
    return { ok: true, received: list.length, applied: await applyAll(events) };
  });

  app.post('/api/webhooks/email/mailgun', async (req) => {
    const key = (await getSetting('email')).mailgun_webhook_signing_key;
    if (!key) throw new HttpError(503, 'Mailgun webhook signing key is not configured');
    const body = (req.body ?? {}) as { signature?: { timestamp?: string; token?: string; signature?: string }; 'event-data'?: Record<string, unknown> };
    const sig = body.signature;
    const expected = sig?.timestamp && sig.token ? createHmac('sha256', key).update(String(sig.timestamp) + String(sig.token)).digest('hex') : '';
    const given = String(sig?.signature ?? '');
    const fresh = Math.abs(Date.now() / 1000 - Number(sig?.timestamp)) < 86_400;
    if (!expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected)) || !fresh) {
      throw new HttpError(401, 'Invalid webhook signature');
    }
    const d = body['event-data'] ?? {};
    const name = String(d.event ?? '');
    const vars = (d['user-variables'] ?? {}) as Record<string, unknown>;
    const status = (d['delivery-status'] ?? {}) as Record<string, unknown>;
    const reason = String(status.description || status.message || d.reason || name).slice(0, 300);
    // failed + permanent is a hard bounce, unless Mailgun itself refused to send (already suppressed there).
    const kind: Kind =
      name === 'failed'
        ? d.severity === 'permanent' ? (/suppress/i.test(String(d.reason ?? '')) ? 'dropped' : 'bounce') : 'ignored'
        : (MAILGUN[name] ?? 'ignored');
    const event: Event = {
      kind,
      emailId: typeof vars.email_id === 'string' && isUuid(vars.email_id) ? vars.email_id : null,
      address: typeof d.recipient === 'string' ? d.recipient : null,
      at: new Date((Number(d.timestamp) || Date.now() / 1000) * 1000),
      reason,
      provider: 'mailgun',
    };
    return { ok: true, received: 1, applied: await applyAll([event]) };
  });
}
