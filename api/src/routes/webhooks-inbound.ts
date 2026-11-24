import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, acceptInbound } from '../lib/inbound-mail.ts';
import type { InboundFile } from '../lib/inbound-mail.ts';
import { HttpError, notFound } from '../lib/http.ts';
import { getSetting } from '../lib/settings.ts';

/**
 * Inbound mail from the provider (SendGrid Inbound Parse, default non-raw
 * mode; Mailgun's field names are understood too).
 *
 *   POST /api/webhooks/email/inbound/:token
 *
 * SendGrid does not sign these requests, so the long random token in the
 * address is the only authentication: it is compared in constant time before
 * any of the body is read, and the route answers 404 when the token is wrong
 * or none has been set in /admin (fail closed).
 *
 * Accepted mail and mail dropped on purpose (blocked sender, not our domain,
 * duplicate) both answer 200, because the provider retries anything else.
 */

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

async function tokenOk(req: FastifyRequest): Promise<boolean> {
  const expected = (await getSetting('email')).inbound_token;
  const given = (req.params as { token?: string }).token ?? '';
  // Hashing first makes the comparison constant-time whatever the lengths are.
  return Boolean(expected) && timingSafeEqual(sha(given), sha(expected));
}

function decoder(label: string | undefined): TextDecoder {
  try {
    return new TextDecoder(label || 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

type Form = { fields: Record<string, string>; files: (InboundFile & { field: string })[]; notes: string[] };

/**
 * The app's multipart limits are sized for comic uploads; this reader has its
 * own. Attachments beyond the caps are read past and left out with a note.
 */
async function readMultipart(req: FastifyRequest): Promise<Form> {
  const raw: Record<string, string> = {};
  const files: Form['files'] = [];
  const notes: string[] = [];
  let total = 0;
  let tooMany = 0;
  const tooBig: string[] = [];
  let overTotal = 0;
  const parts = req.parts({
    // Fields arrive in whatever character set the email used (SendGrid lists them in "charsets"):
    // keep the bytes as they are and decode below.
    defCharset: 'latin1',
    // An oversized file is cut off and flagged (file.truncated) instead of failing the whole message.
    // The option is read by @fastify/multipart at run time but is missing from its per-call type.
    ...({ throwFileSizeLimit: false } as object),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 60, fields: 300, parts: 400, fieldSize: 6 * 1024 * 1024, fieldNameSize: 200 },
  });
  try {
    for await (const part of parts) {
      if (part.type !== 'file') {
        if (!(part.fieldname in raw)) raw[part.fieldname] = typeof part.value === 'string' ? part.value : JSON.stringify(part.value ?? '');
        continue;
      }
      if (files.length >= MAX_ATTACHMENTS) {
        tooMany++;
        for await (const chunk of part.file) void chunk;
        continue;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of part.file as AsyncIterable<Buffer>) {
        chunks.push(chunk);
        size += chunk.length;
      }
      const name = part.filename || part.fieldname;
      if (part.file.truncated) tooBig.push(name);
      else if (total + size > MAX_TOTAL_ATTACHMENT_BYTES) overTotal++;
      else if (size > 0) {
        total += size;
        files.push({ field: part.fieldname, filename: name, contentType: part.mimetype || 'application/octet-stream', data: Buffer.concat(chunks, size) });
      }
    }
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    // More parts than any real email has: keep what was read.
    if (!/^FST_(FILES|PARTS|FIELDS)_LIMIT$/.test(code)) throw new HttpError(400, 'The message could not be read');
    notes.push('This message had more parts than can be handled; some were left out.');
  }
  if (tooMany) notes.push(`${tooMany} more ${tooMany === 1 ? 'attachment was' : 'attachments were'} left out: only the first ${MAX_ATTACHMENTS} are kept.`);
  for (const name of tooBig) notes.push(`The attachment "${name.slice(0, 120)}" was left out because it is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  if (overTotal) notes.push(`${overTotal} ${overTotal === 1 ? 'attachment was' : 'attachments were'} left out: the attachments together were larger than ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB.`);

  let charsets: Record<string, string> = {};
  try {
    charsets = raw.charsets ? (JSON.parse(raw.charsets) as Record<string, string>) : {};
  } catch {
    // everything is read as UTF-8
  }
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    fields[k] = decoder(typeof charsets[k] === 'string' ? charsets[k] : undefined).decode(Buffer.from(v, 'latin1'));
  }

  // SendGrid describes each attachment separately; its filename is the reliable one.
  try {
    const info = fields['attachment-info'] ? (JSON.parse(fields['attachment-info']) as Record<string, { filename?: string; name?: string; type?: string }>) : {};
    for (const file of files) {
      const i = info[file.field];
      if (i?.filename || i?.name) file.filename = String(i.filename || i.name);
      if (i?.type) file.contentType = String(i.type);
    }
  } catch {
    // keep the names from the form
  }
  return { fields, files, notes };
}

export default async function inboundMailWebhook(app: FastifyInstance) {
  await app.register(async (scope) => {
    // Mailgun posts mail without attachments as a plain form.
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 30 * 1024 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    scope.post(
      '/api/webhooks/email/inbound/:token',
      {
        // Before the body is parsed or even read.
        onRequest: async (req) => {
          if (!(await tokenOk(req))) throw notFound();
        },
      },
      async (req) => {
        let form: Form;
        if (req.isMultipart()) form = await readMultipart(req);
        else if (req.body && typeof req.body === 'object') {
          form = { fields: Object.fromEntries(Object.entries(req.body as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])), files: [], notes: [] };
        } else throw new HttpError(400, 'Send the message as multipart/form-data');
        const r = await acceptInbound(form);
        if (r.result !== 'stored') req.log.info({ result: r.result }, 'inbound mail not stored');
        return { ok: true, result: r.result };
      },
    );
  });
}
