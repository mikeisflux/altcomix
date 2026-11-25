import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { exec, one, q } from '../db.ts';
import type { Row } from '../db.ts';
import { escapeHtml, queueEmail } from './email.ts';
import { captureError } from './errors.ts';
import { notify } from './notify.ts';
import { getSetting } from './settings.ts';
import { storage } from './storage.ts';

/**
 * Inbound mail: everything between "the provider posted a message" and "it is
 * in an admin mailbox". The webhook route (routes/webhooks-inbound.ts) reads
 * the form; the admin routes (routes/admin-mailboxes.ts) read and answer.
 *
 * HTML from strangers is hostile. `sanitizeMailHtml` rebuilds it from an
 * allowlist (it never passes input through), and the admin still shows the
 * result only inside a sandboxed frame with its own content security policy.
 */

// ---------------------------------------------------------------- limits

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_HTML_CHARS = 2_000_000;
const MAX_TEXT_CHARS = 500_000;
/** SpamAssassin's usual threshold; SendGrid and Mailgun both report its score. */
const SPAM_SCORE = 5;

// ---------------------------------------------------------------- HTML sanitizer

const VOID_TAGS = new Set(['br', 'hr', 'img', 'col', 'wbr']);
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'font',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strike', 'strong',
  'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'wbr',
]);
/** Elements whose content is code or another document, not prose: removed together with everything inside. (embed and frame have no content: only the tag goes.) */
const DROPPED_WITH_CONTENT = new Set([
  'script', 'style', 'head', 'title', 'textarea', 'noscript', 'iframe', 'frameset', 'object', 'applet', 'template',
  'svg', 'math', 'select', 'noembed', 'noframes', 'xmp', 'plaintext', 'audio', 'video', 'canvas',
]);
const PLAIN_ATTRS = new Set(['align', 'valign', 'width', 'height', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'bgcolor', 'color', 'face', 'size', 'dir', 'lang', 'start']);
const STYLE_PROPS = new Set([
  'color', 'background-color', 'font', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'line-height', 'letter-spacing',
  'text-align', 'text-decoration', 'text-transform', 'text-indent', 'vertical-align', 'white-space', 'word-break', 'display',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style', 'border-width', 'border-radius',
  'border-collapse', 'border-spacing', 'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height', 'list-style-type', 'table-layout',
]);
const MAX_DEPTH = 200;

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', sol: '/', period: '.', comma: ',', semi: ';', equals: '=', num: '#',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', euro: '\u20ac', pound: '\u00a3',
};

/** Entity decoding for attribute values, so `jav&#x61;script:` is judged as what the browser would see. */
function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7});?|#x([0-9a-f]{1,6});?|([a-z]{2,8});)/gi, (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return NAMED[name.toLowerCase()] ?? m;
    const code = dec ? Number(dec) : parseInt(hex as string, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
  });
}

const attrEscape = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Text between tags: existing well-formed entities are kept, everything else that could start markup is escaped. */
function textEscape(s: string): string {
  return s
    .replace(/&(?!(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, '&amp;')
    .replace(/[<>"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** Whitespace and invisible characters a browser ignores inside a URL scheme. */
const stripInvisible = (s: string): string => s.replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060\ufeff]/g, '');

function cleanStyle(value: string): string {
  if (value.length > 4000 || value.includes('\\')) return '';
  const out: string[] = [];
  for (const decl of value.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const i = decl.indexOf(':');
    if (i < 1) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop)) continue;
    // No url(), no functions that fetch or compute, nothing outside a plain value.
    if (!/^[a-zA-Z0-9\s#%.,()'"!+-]{1,200}$/.test(val)) continue;
    if (/(url|image|image-set|expression|var|env|attr|element|paint|cross-fade)\s*\(/i.test(val)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

function cleanAttrs(tag: string, attrs: [string, string][]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [name, raw] of attrs) {
    // A browser keeps the first of a repeated attribute; so do we.
    if (seen.has(name)) continue;
    seen.add(name);
    const v = decodeEntities(raw);
    if (name === 'style') {
      const s = cleanStyle(v);
      if (s) out.push(`style="${attrEscape(s)}"`);
    } else if (tag === 'a' && name === 'href') {
      const url = stripInvisible(v);
      if (url.length <= 2000 && /^(https?:\/\/|mailto:)/i.test(url)) out.push(`href="${attrEscape(url)}"`, `title="${attrEscape(url)}"`);
    } else if (tag === 'img' && name === 'src') {
      const url = stripInvisible(v);
      // Remote images tell the sender the mail was opened: they are parked in data-remote-src
      // and only become src when the admin asks for images. cid: and everything else is dropped.
      if (url.length <= 2000 && /^https?:\/\//i.test(url)) out.push(`data-remote-src="${attrEscape(url)}"`);
      else if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url)) out.push(`src="${url}"`);
    } else if (name === 'alt' || (name === 'title' && tag !== 'a')) {
      out.push(`${name}="${attrEscape(v.slice(0, 300))}"`);
    } else if (PLAIN_ATTRS.has(name) && /^[\w #%.,-]{0,100}$/.test(v)) {
      out.push(`${name}="${attrEscape(v)}"`);
    }
  }
  if (tag === 'a') out.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
  return out.length ? ' ' + out.join(' ') : '';
}

/** Reads a tag's attributes starting after its name. Returns null when the tag never closes. */
function readTag(src: string, start: number): { attrs: [string, string][]; end: number } | null {
  const attrs: [string, string][] = [];
  const n = src.length;
  let pos = start;
  const ws = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
  for (;;) {
    while (pos < n && (ws(src[pos]) || src[pos] === '/')) pos++;
    if (pos >= n) return null;
    if (src[pos] === '>') return { attrs, end: pos + 1 };
    const nameStart = pos;
    while (pos < n && !ws(src[pos]) && src[pos] !== '=' && src[pos] !== '>' && src[pos] !== '/') pos++;
    const name = src.slice(nameStart, pos).toLowerCase();
    if (pos === nameStart) {
      pos++; // a stray "=": skip it
      continue;
    }
    while (pos < n && ws(src[pos])) pos++;
    let value = '';
    if (src[pos] === '=') {
      pos++;
      while (pos < n && ws(src[pos])) pos++;
      const quote = src[pos];
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, pos + 1);
        if (close === -1) return null;
        value = src.slice(pos + 1, close);
        pos = close + 1;
      } else {
        const valueStart = pos;
        while (pos < n && !ws(src[pos]) && src[pos] !== '>') pos++;
        value = src.slice(valueStart, pos);
      }
    }
    if (attrs.length < 64) attrs.push([name, value]);
  }
}

const closers = new Map<string, RegExp>();

/**
 * Rebuilds an email's HTML from an allowlist of tags and attributes. No
 * scripts, event handlers, forms, frames or stylesheets survive; links are
 * http(s)/mailto only; remote images are parked in `data-remote-src`.
 * The output never contains a `"` outside an attribute's quotes, so
 * ` data-remote-src="` can only ever be a real attribute.
 */
export function sanitizeMailHtml(input: string): string {
  const src = input.replace(/\0/g, '').slice(0, MAX_HTML_CHARS);
  const open: string[] = [];
  const tagStart = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
  let out = '';
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      out += textEscape(src.slice(i));
      break;
    }
    if (lt > i) out += textEscape(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    tagStart.lastIndex = lt;
    const m = tagStart.exec(src);
    if (!m) {
      out += '&lt;';
      i = lt + 1;
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const tag = readTag(src, lt + m[0].length);
    if (!tag) break; // a tag that never closes swallows the rest, as it would in a browser
    i = tag.end;
    if (DROPPED_WITH_CONTENT.has(name)) {
      if (!closing) {
        let re = closers.get(name);
        if (!re) closers.set(name, (re = new RegExp(`</${name}[\\s/>]`, 'gi')));
        re.lastIndex = i;
        const close = re.exec(src);
        const end = close ? src.indexOf('>', close.index) : -1;
        i = end === -1 ? src.length : end + 1;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue; // unknown tag: the tag goes, its text stays
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at !== -1) while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }
    if (VOID_TAGS.has(name)) {
      const attrs = cleanAttrs(name, tag.attrs);
      // A picture with no usable source (cid:, a blocked scheme) would only draw a broken-image box.
      if (name !== 'img' || /(^| )(src|data-remote-src)="/.test(attrs)) out += `<${name}${attrs}>`;
    } else if (open.length < MAX_DEPTH) {
      out += `<${name}${cleanAttrs(name, tag.attrs)}>`;
      open.push(name);
    }
  }
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

/** True when a part that claims to be plain text is really markup. */
function looksLikeHtml(s: string): boolean {
  return /<\s*(html|head|body|div|p|br|span|table|tr|td|style|script|a|img|font|meta|center|h[1-6])\b/i.test(s);
}

/** Readable text from an HTML body: code blocks dropped, structure turned into line breaks, link targets kept. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .slice(0, MAX_HTML_CHARS)
      .replace(/<(style|script|head|title|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|ul|ol|section|header|footer)\s*>/gi, '\n')
      .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, inner: string) => {
        const text = inner.replace(/<[^>]+>/g, '').trim();
        // Only real web addresses are worth showing next to the link text.
        if (!/^https?:\/\//i.test(href)) return ` ${text} `;
        if (!text) return ` ${href} `;
        return href.includes(text) ? ` ${text} ` : ` ${text} (${href}) `;
      })
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The best plain-text version of a message: the sender's own text part when it really is text. */
export function mailText(text: string, html: string): string {
  const t = text.trim();
  if (t && !looksLikeHtml(t)) return t.replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n');
  if (html.trim()) return htmlToText(html);
  return t ? htmlToText(t) : '';
}

// ---------------------------------------------------------------- headers and addresses

/** Raw header block -> lower-case name -> first value (folded lines joined). */
export function parseHeaders(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.replace(/\r\n?/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(i + 1).trim());
  }
  return out;
}

/** Message-IDs out of a Message-ID, In-Reply-To or References value, without the angle brackets. */
export function messageIds(value: string | undefined | null): string[] {
  if (!value) return [];
  const found = [...value.matchAll(/<([^<>\s]{1,300})>/g)].map((m) => m[1]);
  if (found.length) return found.slice(-30);
  const bare = value.trim();
  return bare && !/\s/.test(bare) && bare.length <= 300 ? [bare] : [];
}

const ADDRESS = /[^\s<>,;:"()[\]]+@[^\s<>,;:"()[\]@]+/;

/** `"Sam Reader" <sam@example.com>` -> address (lower case) and display name. */
export function parseAddress(input: string | undefined | null): { email: string; name: string } {
  const s = (input ?? '').trim();
  const angle = /^(.*)<([^<>]+)>\s*$/.exec(s);
  const email = (ADDRESS.exec(angle ? angle[2] : s)?.[0] ?? '').toLowerCase().replace(/\.$/, '');
  const name = angle ? angle[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1').trim() : '';
  return { email, name: name.slice(0, 200) };
}

export function addressList(input: string | undefined | null): string[] {
  return [...(input ?? '').matchAll(new RegExp(ADDRESS.source, 'g'))].map((m) => m[0].toLowerCase().replace(/\.$/, ''));
}

export const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1);

/** The domains this site receives mail for: the site's own host and the From address's domain. */
export async function ownDomains(): Promise<string[]> {
  const out = new Set<string>();
  try {
    const host = new URL(config.appUrl).hostname.toLowerCase().replace(/^www\./, '');
    if (host) out.add(host);
  } catch {
    // appUrl is validated at start-up; an odd value just means no domain from it
  }
  const from = (await getSetting('email')).from_email.toLowerCase();
  if (from.includes('@')) out.add(domainOf(from));
  return [...out];
}

export const onDomain = (domain: string, list: string[]): boolean => list.some((d) => domain === d || domain.endsWith('.' + d));

// ---------------------------------------------------------------- threading

const normalSubject = (subject: string): string => subject.replace(/^(\s*(re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Fallback when no header links a message to a conversation: same mailbox, same person, same subject. */
export function subjectThreadKey(mailboxId: string, subject: string, correspondent: string): string {
  const s = normalSubject(subject);
  if (!s) return `m:${randomUUID()}`;
  return 's:' + createHash('sha256').update(`${mailboxId}\n${s}\n${correspondent.toLowerCase()}`).digest('hex').slice(0, 32);
}

async function threadKeyFor(mailboxId: string, subject: string, correspondent: string, refs: string[]): Promise<string> {
  if (refs.length) {
    const hit = await one<{ thread_key: string }>('select thread_key from inbound_emails where message_id = any($1::text[]) order by received_at desc limit 1', [refs]);
    if (hit) return hit.thread_key;
    // Something we sent: providers that return the Message-ID (Mailgun) store it as the queue row's provider id.
    const sent = await one<{ thread_key: string }>(
      `select r.thread_key from mailbox_replies r join emails e on e.id = r.email_id
        where trim(both '<>' from e.provider_id) = any($1::text[]) order by r.created_at desc limit 1`,
      [refs],
    );
    if (sent) return sent.thread_key;
  }
  return subjectThreadKey(mailboxId, subject, correspondent);
}

// ---------------------------------------------------------------- blocklist

export async function blockedSender(email: string): Promise<{ id: string; kind: string; value: string } | null> {
  const domain = domainOf(email);
  return one(
    `select id, kind, value from inbound_blocklist
      where (kind = 'address' and value = $1) or (kind = 'domain' and ($2 = value or $2 like '%.' || value))
      limit 1`,
    [email, domain],
  );
}

// ---------------------------------------------------------------- sending from a mailbox

export type Mailbox = { id: string; address: string; name: string; is_default: boolean; active: boolean; auto_reply: string };

const textToHtml = (text: string): string => escapeHtml(text).replace(/\r?\n/g, '<br>\n');

/**
 * Queue a message from a mailbox's own address and record it on the thread.
 * `inbound` is the message being answered: its ids become In-Reply-To and
 * References so the conversation threads in the other person's mail program.
 */
export async function sendFromMailbox(o: {
  mailbox: Mailbox;
  to: string;
  subject: string;
  text: string;
  kind: 'reply' | 'new' | 'auto_reply';
  inbound?: Row | null;
  sentBy?: string | null;
}): Promise<{ id: string; email_id: string | null; status: string; error: string | null }> {
  const headers: Record<string, string> = {};
  let html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1c20">${textToHtml(o.text)}</div>`;
  let text = o.text;
  if (o.inbound) {
    const refs = [...((o.inbound.reference_ids as string[]) ?? []), ...(o.inbound.message_id ? [o.inbound.message_id as string] : [])].slice(-20);
    if (o.inbound.message_id) headers['In-Reply-To'] = `<${o.inbound.message_id}>`;
    if (refs.length) headers['References'] = refs.map((r) => `<${r}>`).join(' ');
    if (o.kind === 'reply') {
      const who = o.inbound.from_name ? `${o.inbound.from_name} <${o.inbound.from_email}>` : String(o.inbound.from_email);
      const when = new Date(o.inbound.received_at as string).toUTCString();
      const quoted = String(o.inbound.text_body ?? '').slice(0, 20_000);
      if (quoted) {
        text += `\n\nOn ${when}, ${who} wrote:\n${quoted.split('\n').map((l) => `> ${l}`).join('\n')}`;
        html += `<p style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#6b7078">On ${escapeHtml(when)}, ${escapeHtml(who)} wrote:</p>`
          + `<blockquote style="margin:0 0 0 8px;padding-left:12px;border-left:2px solid #cfd2d8;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#4a4e57">${textToHtml(quoted)}</blockquote>`;
      }
    }
  }
  if (o.kind === 'auto_reply') {
    // RFC 3834: mark it, so other auto-responders (and ours) leave it alone.
    headers['Auto-Submitted'] = 'auto-replied';
    headers['X-Auto-Response-Suppress'] = 'All';
  }
  const emailId = await queueEmail({
    to: o.to,
    subject: o.subject,
    html,
    text,
    template: o.kind === 'auto_reply' ? 'mailbox_auto_reply' : 'mailbox_reply',
    category: 'transactional',
    from: { email: o.mailbox.address, name: o.mailbox.name },
    replyTo: o.mailbox.address,
    headers,
  });
  const queued = emailId ? await one<{ status: string; error: string | null }>('select status, error from emails where id = $1', [emailId]) : null;
  const threadKey = (o.inbound?.thread_key as string | undefined) ?? subjectThreadKey(o.mailbox.id, o.subject, o.to);
  const row = await one<{ id: string }>(
    `insert into mailbox_replies (mailbox_id, thread_key, inbound_id, email_id, kind, from_email, to_email, subject, text_body, sent_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [o.mailbox.id, threadKey, o.inbound?.id ?? null, emailId, o.kind, o.mailbox.address, o.to.toLowerCase(), o.subject, o.text, o.sentBy ?? null],
  );
  return { id: row!.id, email_id: emailId, status: queued?.status ?? 'invalid', error: queued?.error ?? null };
}

export const replySubject = (subject: string): string => (/^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`).slice(0, 300);

/** Senders an automatic reply must never go to: robots, bounces, lists. Answering them is how mail loops start. */
export function isAutomated(fromEmail: string, headers: Map<string, string>): boolean {
  const local = fromEmail.slice(0, fromEmail.lastIndexOf('@'));
  if (/^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|listserv|majordomo)([-+._].*)?$/i.test(local) || /(^|[-+._])(noreply|no-reply|bounces?)$/i.test(local)) return true;
  const auto = (headers.get('auto-submitted') ?? '').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (/^(bulk|list|junk|auto_reply)/i.test(headers.get('precedence') ?? '')) return true;
  if (headers.has('list-id') || headers.has('list-unsubscribe') || headers.has('x-auto-response-suppress') || headers.has('x-autoreply') || headers.has('x-autorespond') || headers.has('x-loop')) return true;
  const returnPath = headers.get('return-path');
  return returnPath !== undefined && returnPath.replace(/\s/g, '') === '<>';
}

// ---------------------------------------------------------------- accepting a message

export type InboundFile = { filename: string; contentType: string; data: Buffer };
export type InboundMessage = {
  /** Form fields as the provider posted them, already decoded to text. */
  fields: Record<string, string>;
  files: InboundFile[];
  /** Notes about attachments the reader already left out (too many, too large). */
  notes: string[];
};
export type InboundResult = { result: 'stored' | 'duplicate' | 'blocked' | 'not_ours' | 'no_sender' | 'no_mailbox'; id?: string };

const cleanFilename = (name: string, n: number): string =>
  (name.replace(/[\u0000-\u001f\u007f"<>|:*?\\/]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(-180) || `attachment-${n}`);

/** Mailgun posts headers as a JSON list of [name, value]; SendGrid as the raw block. */
function headersOf(f: Record<string, string>): Map<string, string> {
  if (f.headers) return parseHeaders(f.headers);
  const out = new Map<string, string>();
  try {
    for (const pair of JSON.parse(f['message-headers'] ?? '[]') as [string, string][]) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && !out.has(pair[0].toLowerCase())) out.set(pair[0].toLowerCase(), String(pair[1] ?? ''));
    }
  } catch {
    // no usable header list
  }
  return out;
}

async function pickMailbox(recipients: string[], own: string[]): Promise<{ mailbox: Mailbox | null; to: string | null }> {
  const boxes = await q<Mailbox>('select id, address, name, is_default, active, auto_reply from mailboxes order by created_at');
  // A message can be delivered to several of our addresses at once: the first that has its own mailbox wins.
  for (const r of recipients) {
    const exact = boxes.find((b) => b.active && b.address === r);
    if (exact) return { mailbox: exact, to: r };
  }
  const to = recipients.find((r) => onDomain(domainOf(r), own)) ?? null;
  if (!to) return { mailbox: null, to: null };
  if (!boxes.length) {
    // First mail ever: start with a support mailbox on the domain it arrived at.
    await exec(`insert into mailboxes (address, name, is_default) values ($1, 'Support', true) on conflict do nothing`, [`support@${domainOf(to)}`]);
    const made = await one<Mailbox>('select id, address, name, is_default, active, auto_reply from mailboxes order by created_at limit 1');
    return { mailbox: made, to };
  }
  return { mailbox: boxes.find((b) => b.active && b.is_default) ?? boxes.find((b) => b.active) ?? null, to };
}

/**
 * Files one posted message. Returns what happened; throws only when the
 * database is unavailable (the provider then delivers it again later).
 */
export async function acceptInbound(msg: InboundMessage): Promise<InboundResult> {
  const f = msg.fields;
  const headers = headersOf(f);
  const from = parseAddress(f.from || headers.get('from') || f.sender);
  let envelope: { to?: unknown; from?: unknown } = {};
  try {
    envelope = f.envelope ? (JSON.parse(f.envelope) as typeof envelope) : {};
  } catch {
    // fall back to the headers
  }
  if (!from.email && typeof envelope.from === 'string') from.email = parseAddress(envelope.from).email;
  if (!from.email) from.email = parseAddress(f.sender).email;
  if (!from.email) return { result: 'no_sender' };

  const block = await blockedSender(from.email);
  if (block) {
    await exec('update inbound_blocklist set hits = hits + 1, last_hit_at = now() where id = $1', [block.id]);
    return { result: 'blocked' };
  }

  // Who it was really delivered to: the SMTP envelope, not the To header (which a sender can write freely).
  const envelopeTo = Array.isArray(envelope.to) ? envelope.to.filter((x): x is string => typeof x === 'string') : typeof envelope.to === 'string' ? [envelope.to] : [];
  const toHeader = f.to || headers.get('to') || '';
  let recipients = envelopeTo.flatMap((r) => addressList(r));
  if (!recipients.length) recipients = addressList(f.recipient);
  if (!recipients.length) recipients = addressList(toHeader);
  const own = await ownDomains();
  const { mailbox, to } = await pickMailbox(recipients, own);
  if (!to) return { result: 'not_ours' };
  if (!mailbox) return { result: 'no_mailbox' };

  const messageId = messageIds(headers.get('message-id') ?? f['Message-Id'] ?? f['message-id'])[0] ?? null;
  const inReplyTo = messageIds(headers.get('in-reply-to') ?? f['In-Reply-To'])[0] ?? null;
  const references = messageIds(headers.get('references') ?? f.References);
  if (messageId && (await one('select 1 from inbound_emails where message_id = $1', [messageId]))) return { result: 'duplicate' };

  const subject = (f.subject ?? headers.get('subject') ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const rawHtml = f.html || f['body-html'] || f['stripped-html'] || '';
  const rawText = f.text || f['body-plain'] || f['stripped-text'] || '';
  const notes = [...msg.notes];
  if (rawHtml.length > MAX_HTML_CHARS) notes.push('The formatted version of this message was very long and has been cut short.');
  let text = mailText(rawText, rawHtml);
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    notes.push('This message was very long and has been cut short.');
  }
  const html = rawHtml ? sanitizeMailHtml(rawHtml) : '';

  const score = Number.parseFloat(f.spam_score ?? f['X-Mailgun-Sscore'] ?? '');
  const spamScore = Number.isFinite(score) ? score : null;
  const spam = (f['X-Mailgun-Sflag'] ?? '').toLowerCase() === 'yes' || (spamScore !== null && spamScore >= SPAM_SCORE);
  // Junk does not get to fill the storage bucket.
  const files = spam ? [] : msg.files;
  if (spam && msg.files.length) notes.push(`${msg.files.length} ${msg.files.length === 1 ? 'attachment was' : 'attachments were'} not kept because the message was flagged as spam.`);

  const replyTo = parseAddress(headers.get('reply-to')).email;
  const threadKey = await threadKeyFor(mailbox.id, subject, from.email, [...(inReplyTo ? [inReplyTo] : []), ...references]);
  const row = await one<Row>(
    `insert into inbound_emails (mailbox_id, from_email, from_name, reply_to, to_email, to_header, cc, subject, text_body, html_body,
                                 message_id, in_reply_to, reference_ids, spam_flagged, spam_score, spf, dkim, spam, thread_key, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$14,$18,$19)
     on conflict (message_id) where message_id is not null do nothing
     returning *`,
    [mailbox.id, from.email, from.name, replyTo && replyTo !== from.email ? replyTo : null, to, toHeader.slice(0, 2000), (f.cc || f.Cc || headers.get('cc') || '').slice(0, 2000),
     subject, text, html, messageId, inReplyTo, references, spam, spamScore, (f.SPF ?? '').slice(0, 200) || null, (f.dkim ?? '').slice(0, 500) || null, threadKey, notes],
  );
  // Two deliveries of the same message raced: the other one stored it.
  if (!row) return { result: 'duplicate' };

  // From here the message is safely stored; nothing below may turn the delivery into an error.
  if (files.length) {
    try {
      const store = await storage();
      let n = 0;
      for (const file of files) {
        n++;
        const key = `private/inbound-mail/${row.id}/${randomUUID()}`;
        await store.put(key, file.data, 'application/octet-stream');
        await exec('insert into inbound_attachments (email_id, storage_key, filename, content_type, size_bytes) values ($1,$2,$3,$4,$5)', [
          row.id, key, cleanFilename(file.filename, n), file.contentType.slice(0, 200) || 'application/octet-stream', file.data.length,
        ]);
      }
    } catch (e) {
      captureError(e, { source: 'api', endpoint: 'inbound mail: store attachments', meta: { emailId: row.id } });
      await exec(`update inbound_emails set notes = array_append(notes, 'Some attachments could not be saved.') where id = $1`, [row.id]).catch(() => {});
    }
  }

  if (!spam) {
    try {
      const staff = await q<{ id: string }>(`select id from users where role in ('admin','super_admin') and deleted_at is null and banned_at is null`);
      const who = from.name ? `${from.name} <${from.email}>` : from.email;
      for (const s of staff) {
        await notify(s.id, 'inbox', `New email to ${mailbox.name}: ${(subject || '(no subject)').slice(0, 120)}`, `From ${who}. ${text.replace(/\s+/g, ' ').slice(0, 300)}`, `/admin/inbox?open=${row.id}`);
      }
    } catch (e) {
      captureError(e, { source: 'api', endpoint: 'inbound mail: notify staff', meta: { emailId: row.id } });
    }
    try {
      await autoReply(mailbox, row, headers);
    } catch (e) {
      captureError(e, { source: 'api', endpoint: 'inbound mail: auto-reply', meta: { emailId: row.id } });
    }
  }
  return { result: 'stored', id: row.id as string };
}

/** The mailbox's automatic reply: at most one per sender per day, never to robots, lists or ourselves. */
async function autoReply(mailbox: Mailbox, inbound: Row, headers: Map<string, string>): Promise<void> {
  if (!mailbox.auto_reply.trim()) return;
  const to = (inbound.reply_to as string | null) || (inbound.from_email as string);
  for (const address of new Set([to, inbound.from_email as string])) {
    if (isAutomated(address, headers)) return;
    if (await one('select 1 from mailboxes where address = $1', [address])) return;
  }
  if (to === (await getSetting('email')).from_email.toLowerCase()) return;
  const recent = await one(
    `select 1 from mailbox_replies where mailbox_id = $1 and to_email = $2 and kind = 'auto_reply' and created_at > now() - interval '24 hours' limit 1`,
    [mailbox.id, to],
  );
  if (recent) return;
  await sendFromMailbox({ mailbox, to, subject: replySubject(inbound.subject as string), text: mailbox.auto_reply.trim(), kind: 'auto_reply', inbound });
}

/** Remove a message's stored attachments (the rows go with the email). */
export async function dropAttachments(where: string, params: unknown[]): Promise<void> {
  const rows = await q<{ storage_key: string }>(`select a.storage_key from inbound_attachments a join inbound_emails e on e.id = a.email_id where ${where}`, params);
  if (!rows.length) return;
  const store = await storage();
  for (const r of rows) await store.del(r.storage_key).catch(() => {});
}
