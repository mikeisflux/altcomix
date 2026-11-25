import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { exec, one, patch, q, tx } from '../db.ts';
import { rateLimit } from '../lib/botblock.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { sendTemplate } from '../lib/email.ts';
import { HttpError, audit, badRequest, conflict, forbidden, isAdmin, notFound, parse, requireMember, requireUser, uniqueSlug } from '../lib/http.ts';
import type { MemberRole } from '../lib/http.ts';
import { idParam, receiveImage, requireVerifiedEmail, storeWebp } from '../lib/ingest.ts';
import type { Row } from '../db.ts';
import { publicUrl, storage } from '../lib/storage.ts';
import { LANGUAGES } from '../lib/taxonomy.ts';

/** Studio: brands (identity, images, payout details, team, conventions). */

const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as string[];
const RESERVED = new Set(['admin', 'api', 'studio', 'media', 'read', 'store', 'library', 'login', 'register', 'settings', 'widgets', 'new']);
const SOCIAL_KEYS = ['x', 'facebook', 'instagram', 'bluesky', 'youtube', 'discord', 'tiktok'] as const;
const ROLES = ['owner', 'admin', 'editor', 'analyst'] as const;
const RANK: Record<MemberRole, number> = { analyst: 1, editor: 2, admin: 3, owner: 4 };
const PAYOUT_METHODS = ['paypal', 'wise', 'bank_transfer'] as const;

const emptyToNull = (v: string) => (v === '' ? null : v);
const link = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || (/^https?:\/\//i.test(v) && URL.canParse(v)), 'Enter a full link starting with https://')
  .transform(emptyToNull)
  .nullable();

const timezones = new Set<string>([...Intl.supportedValuesOf('timeZone'), 'UTC']);

const identity = z.object({
  name: z.string().trim().min(2, 'Brand name must be at least 2 characters').max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$/, 'Use 3-60 lowercase letters, numbers and dashes'),
  bio: z.string().trim().max(400, 'Bio can be at most 400 characters'),
  kind: z.enum(['creator', 'publisher']),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a 2-letter country code').nullable(),
  primary_language: z.string().refine((v) => LANGUAGE_CODES.includes(v), 'Unknown language'),
  timezone: z.string().refine((v) => timezones.has(v), 'Unknown timezone').nullable(),
  ga_tracking_id: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === '' || /^(G-[A-Z0-9]{4,20}|UA-\d{4,12}-\d{1,4})$/.test(v), 'Use a Google Analytics ID like G-XXXXXXXXXX')
    .transform(emptyToNull)
    .nullable(),
  membership_note: z.string().trim().max(1000),
  website: link,
  socials: z.partialRecord(z.enum(SOCIAL_KEYS), z.string().trim().max(200)),
  tips_enabled: z.boolean(),
  monthly_goal_cents: z.number().int().min(0).max(100_000_000).nullable(),
});

function maskDestination(dest: string): string {
  const at = dest.indexOf('@');
  if (at > 0) return `${dest[0]}${'•'.repeat(Math.max(2, Math.min(6, at - 1)))}${dest.slice(at)}`;
  const tail = dest.replace(/\s+/g, '').slice(-4);
  return `••••${tail}`;
}

async function brandView(b: Row, role: MemberRole) {
  return {
    id: b.id,
    slug: b.slug,
    name: b.name,
    kind: b.kind,
    kind_requested: b.kind_requested,
    bio: b.bio,
    avatar_url: await publicUrl(b.avatar_key),
    banner_url: await publicUrl(b.banner_key),
    website: b.website,
    socials: b.socials ?? {},
    country: b.country,
    timezone: b.timezone,
    primary_language: b.primary_language,
    ga_tracking_id: b.ga_tracking_id,
    membership_note: b.membership_note,
    tips_enabled: b.tips_enabled,
    monthly_goal_cents: b.monthly_goal_cents,
    verified: Boolean(b.verified_at),
    suspended: Boolean(b.suspended_at),
    suspend_reason: b.suspended_at ? b.suspend_reason : null,
    payout_configured: Boolean(b.payout?.method && b.payout?.destination),
    created_at: b.created_at,
    role,
  };
}

async function loadBrand(id: string): Promise<Row> {
  const b = await one('select * from publishers where id = $1 and deleted_at is null', [id]);
  if (!b) throw notFound('Brand not found');
  return b;
}

async function ownerCount(brandId: string): Promise<number> {
  return (await one<{ n: number }>(`select count(*)::int as n from publisher_members where publisher_id = $1 and role = 'owner'`, [brandId]))!.n;
}

export default async function (app: FastifyInstance) {
  // ------------------------------------------------------------ brands

  app.get('/api/studio/brands', async (req) => {
    const u = requireUser(req);
    const rows = await q(
      `select p.*, m.role,
              (select count(*)::int from series s where s.publisher_id = p.id and s.deleted_at is null) as series_count,
              (select count(*)::int from publisher_members pm where pm.publisher_id = p.id) as member_count
         from publisher_members m join publishers p on p.id = m.publisher_id
        where m.user_id = $1 and p.deleted_at is null
        order by p.name`,
      [u.id],
    );
    const brands = [];
    for (const r of rows) brands.push({ ...(await brandView(r, r.role)), series_count: r.series_count, member_count: r.member_count });
    return { brands };
  });

  app.post('/api/studio/brands', async (req, reply) => {
    const u = requireVerifiedEmail(req);
    const body = parse(identity.partial().required({ name: true }), req.body);
    if (!rateLimit('brand_create', u.id, 5, 3600)) throw new HttpError(429, 'You have created several brands in a short time. Try again later.');
    let slug: string;
    if (body.slug) {
      if (RESERVED.has(body.slug)) throw conflict('That URL is reserved. Choose another.');
      if (await one('select 1 from publishers where slug = $1', [body.slug])) throw conflict('That URL is already taken. Choose another.');
      slug = body.slug;
    } else {
      slug = await uniqueSlug('publishers', body.name);
      if (RESERVED.has(slug)) slug = await uniqueSlug('publishers', `${body.name}-comics`);
    }
    const brand = await tx(async (db) => {
      const ins = await db.query(
        `insert into publishers (slug, name, bio, kind_requested, country, primary_language, timezone, ga_tracking_id, membership_note,
                                 website, socials, tips_enabled, monthly_goal_cents)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
        [slug, body.name, body.bio ?? '', body.kind === 'publisher' ? 'publisher' : null, body.country ?? null, body.primary_language ?? 'en',
         body.timezone ?? null, body.ga_tracking_id ?? null, body.membership_note ?? '', body.website ?? null, JSON.stringify(body.socials ?? {}),
         body.tips_enabled ?? true, body.monthly_goal_cents ?? null],
      );
      await db.query(`insert into publisher_members (publisher_id, user_id, role) values ($1,$2,'owner')`, [ins.rows[0].id, u.id]);
      return ins.rows[0] as Row;
    }).catch((e: { code?: string }) => {
      if (e.code === '23505') throw conflict('That URL is already taken. Choose another.');
      throw e;
    });
    audit(req, 'brand.create', { kind: 'publisher', id: brand.id });
    reply.code(201);
    return { brand: await brandView(brand, 'owner') };
  });

  /**
   * Open a brand by its URL name. Members get their own role. A platform admin
   * who is not a member gets in with owner-level controls and `viewing_as_admin`
   * set, so the Studio can say so. Registered before `/:id`; a slug is never a uuid.
   */
  app.get('/api/studio/brands/by-slug/:slug', async (req) => {
    const u = requireUser(req);
    const slug = String((req.params as { slug: string }).slug ?? '').toLowerCase();
    const b = await one('select * from publishers where slug = $1 and deleted_at is null', [slug]);
    if (!b) throw notFound('Brand not found');
    const member = await one<{ role: MemberRole }>('select role from publisher_members where publisher_id = $1 and user_id = $2', [b.id, u.id]);
    if (!member && !isAdmin(u)) throw forbidden('You are not a member of this brand');
    const counts = await one(
      `select (select count(*)::int from series s where s.publisher_id = $1 and s.deleted_at is null) as series_count,
              (select count(*)::int from publisher_members pm where pm.publisher_id = $1) as member_count,
              (select count(*)::int from publisher_follows f where f.publisher_id = $1) as follower_count`,
      [b.id],
    );
    // Same rule as requireMember: a platform admin acts as an owner everywhere in the Studio.
    const role: MemberRole = isAdmin(u) ? 'owner' : member!.role;
    return { brand: { ...(await brandView(b, role)), ...counts, member_role: member?.role ?? null, viewing_as_admin: isAdmin(u) && !member } };
  });

  app.get('/api/studio/brands/:id', async (req) => {
    const id = idParam(req);
    const role = await requireMember(req, id, 'analyst');
    const b = await loadBrand(id);
    const counts = await one(
      `select (select count(*)::int from series s where s.publisher_id = $1 and s.deleted_at is null) as series_count,
              (select count(*)::int from publisher_members pm where pm.publisher_id = $1) as member_count,
              (select count(*)::int from publisher_follows f where f.publisher_id = $1) as follower_count`,
      [id],
    );
    return { brand: { ...(await brandView(b, role)), ...counts } };
  });

  app.patch('/api/studio/brands/:id', async (req) => {
    const id = idParam(req);
    const role = await requireMember(req, id, 'admin');
    const b = await loadBrand(id);
    const body = parse(identity.partial(), req.body) as Row;
    if (body.slug && body.slug !== b.slug) {
      if (RESERVED.has(body.slug)) throw conflict('That URL is reserved. Choose another.');
      if (await one('select 1 from publishers where slug = $1 and id <> $2', [body.slug, id])) throw conflict('That URL is already taken. Choose another.');
    }
    // Creator <-> Publisher is a request; a platform admin approves it.
    if (body.kind !== undefined) {
      body.kind_requested = body.kind === b.kind ? null : body.kind;
      delete body.kind;
    }
    if (body.socials) body.socials = Object.fromEntries(Object.entries(body.socials).filter(([, v]) => v));
    const { sets, values } = patch(
      body,
      ['name', 'slug', 'bio', 'kind_requested', 'country', 'primary_language', 'timezone', 'ga_tracking_id', 'membership_note', 'website',
       'socials', 'tips_enabled', 'monthly_goal_cents'],
      2,
    );
    if (!sets.length) return { brand: await brandView(b, role) };
    const updated = await one(`update publishers set ${sets.join(', ')} where id = $1 returning *`, [id, ...values]);
    audit(req, 'brand.update', { kind: 'publisher', id }, { fields: Object.keys(body) });
    return { brand: await brandView(updated!, role) };
  });

  /** Money still owed to (or by) the brand, and what deleting it would take with it. Owner only. */
  const deletionState = async (id: string) => {
    const r = (await one<{ balance: number; open_payouts: number; open_payout_cents: number; series: number; published: number; owned: number; codes: number }>(
      `select (select coalesce(sum(amount_cents), 0)::int from ledger where publisher_id = $1) as balance,
              (select count(*)::int from payouts where publisher_id = $1 and status in ('requested','approved')) as open_payouts,
              (select coalesce(sum(amount_cents), 0)::int from payouts where publisher_id = $1 and status in ('requested','approved')) as open_payout_cents,
              (select count(*)::int from series where publisher_id = $1 and deleted_at is null) as series,
              (select count(*)::int from releases r join series s on s.id = r.series_id
                where s.publisher_id = $1 and s.deleted_at is null and r.deleted_at is null and r.status = 'published') as published,
              (select count(*)::int from entitlements e join releases r on r.id = e.release_id join series s on s.id = r.series_id
                where s.publisher_id = $1 and s.deleted_at is null) as owned,
              (select count(*)::int from promo_codes c where c.publisher_id = $1 and c.disabled_at is null
                  and (c.expires_at is null or c.expires_at > now())
                  and (c.max_redemptions is null or c.redeemed_count < c.max_redemptions)) as codes`,
      [id],
    ))!;
    const blockers: string[] = [];
    if (r.balance > 0) blockers.push('This brand still has earnings that have not been paid out. Request a payout and wait for it to be paid before deleting the brand.');
    if (r.open_payouts > 0) blockers.push('A payout for this brand is still being processed. Wait until it has been paid (or withdraw the request) before deleting the brand.');
    return {
      balance_cents: r.balance, open_payouts: r.open_payouts, open_payout_cents: r.open_payout_cents, series_count: r.series,
      published_release_count: r.published, owned_copies: r.owned, usable_codes: r.codes, can_delete: blockers.length === 0, blockers,
    };
  };

  app.get('/api/studio/brands/:id/deletion', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'owner');
    await loadBrand(id);
    return deletionState(id);
  });

  /**
   * Soft-deletes the brand and all of its series. Refused while money is owed:
   * a positive balance (earned, including the part still on hold) or a payout
   * that has been requested or approved but not yet paid.
   */
  app.delete('/api/studio/brands/:id', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'owner');
    await loadBrand(id);
    await tx(async (db) => {
      // Same lock as a payout request, so one cannot slip in between the check and the delete.
      await db.query('select id from publishers where id = $1 for update', [id]);
      const owed = (await db.query('select coalesce(sum(amount_cents), 0)::int as balance from ledger where publisher_id = $1', [id])).rows[0];
      if (owed.balance > 0) throw conflict('This brand still has earnings that have not been paid out. Request a payout and wait for it to be paid before deleting the brand.');
      const open = (await db.query(`select count(*)::int as n from payouts where publisher_id = $1 and status in ('requested','approved')`, [id])).rows[0];
      if (open.n > 0) throw conflict('A payout for this brand is still being processed. Wait until it has been paid (or withdraw the request) before deleting the brand.');
      await db.query('update publishers set deleted_at = now() where id = $1', [id]);
      await db.query('update series set deleted_at = now() where publisher_id = $1 and deleted_at is null', [id]);
    });
    audit(req, 'brand.delete', { kind: 'publisher', id });
    return { ok: true };
  });

  for (const kind of ['avatar', 'banner'] as const) {
    const column = `${kind}_key`;
    app.post(`/api/studio/brands/:id/${kind}`, async (req) => {
      const id = idParam(req);
      await requireMember(req, id, 'admin');
      const b = await loadBrand(id);
      const img = await receiveImage(req);
      try {
        const key = `public/brands/${id}/${kind}-${Date.now().toString(36)}.webp`;
        if (kind === 'avatar') await storeWebp(key, img.path, 400, 400);
        else await storeWebp(key, img.path, 1600, 400);
        await exec(`update publishers set ${column} = $2 where id = $1`, [id, key]);
        if (b[column]) await (await storage()).del(b[column]).catch(() => {});
        audit(req, `brand.${kind}`, { kind: 'publisher', id });
        return { [`${kind}_url`]: await publicUrl(key) };
      } finally {
        await img.cleanup();
      }
    });

    app.delete(`/api/studio/brands/:id/${kind}`, async (req) => {
      const id = idParam(req);
      await requireMember(req, id, 'admin');
      const b = await loadBrand(id);
      await exec(`update publishers set ${column} = null where id = $1`, [id]);
      if (b[column]) await (await storage()).del(b[column]).catch(() => {});
      return { ok: true };
    });
  }

  // ------------------------------------------------------------ payout details (admin / owner)

  const payoutView = (p: Row | null) => ({
    configured: Boolean(p?.method && p?.destination),
    method: p?.method ?? null,
    legal_name: p?.legal_name ?? null,
    // The full destination is never sent back; this is enough to recognize it.
    destination_hint: p?.destination ? maskDestination(String(p.destination)) : null,
    updated_at: p?.updated_at ?? null,
  });

  app.get('/api/studio/brands/:id/payout', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const b = await loadBrand(id);
    return { payout: payoutView(b.payout), methods: PAYOUT_METHODS };
  });

  app.put('/api/studio/brands/:id/payout', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    await loadBrand(id);
    const body = parse(
      z.object({
        method: z.enum(PAYOUT_METHODS),
        destination: z.string().trim().min(5, 'Enter where the money should go').max(200),
        legal_name: z.string().trim().min(2, 'Enter the legal name of the payee').max(120),
      }),
      req.body,
    );
    if (body.method !== 'bank_transfer' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.destination)) {
      throw badRequest('Enter the email address of the account that should be paid');
    }
    const payout = { ...body, updated_at: new Date().toISOString() };
    await exec('update publishers set payout = $2 where id = $1', [id, JSON.stringify(payout)]);
    audit(req, 'brand.payout_settings', { kind: 'publisher', id }, { method: body.method });
    return { payout: payoutView(payout) };
  });

  // ------------------------------------------------------------ team

  app.get('/api/studio/brands/:id/members', async (req) => {
    const id = idParam(req);
    const role = await requireMember(req, id, 'analyst');
    const canManage = RANK[role] >= RANK.admin;
    const rows = await q(
      `select m.user_id, m.role, m.created_at, u.username, u.display_name, u.avatar_key, u.email
         from publisher_members m join users u on u.id = m.user_id
        where m.publisher_id = $1
        order by array_position(array['owner','admin','editor','analyst'], m.role), m.created_at`,
      [id],
    );
    const members = [];
    for (const r of rows) {
      members.push({
        user_id: r.user_id, username: r.username, display_name: r.display_name, avatar_url: await publicUrl(r.avatar_key),
        role: r.role, created_at: r.created_at, email: canManage ? r.email : undefined, is_you: r.user_id === req.user!.id,
      });
    }
    const invites = canManage
      ? await q(
          `select i.id, i.email, i.role, i.created_at, i.expires_at, u.username as invited_by
             from publisher_invites i left join users u on u.id = i.invited_by
            where i.publisher_id = $1 and i.accepted_at is null and i.expires_at > now()
            order by i.created_at desc`,
          [id],
        )
      : [];
    return { members, invites, roles: ROLES, your_role: role };
  });

  app.patch('/api/studio/brands/:id/members/:userId', async (req) => {
    const id = idParam(req);
    const userId = idParam(req, 'userId');
    const actor = await requireMember(req, id, 'admin');
    const body = parse(z.object({ role: z.enum(ROLES) }), req.body);
    const target = await one<{ role: MemberRole }>('select role from publisher_members where publisher_id = $1 and user_id = $2', [id, userId]);
    if (!target) throw notFound('That person is not a member of this brand');
    if (actor !== 'owner' && (RANK[target.role] >= RANK.admin || RANK[body.role] >= RANK.admin)) {
      throw forbidden('Only an owner can change admins and owners');
    }
    if (target.role === 'owner' && body.role !== 'owner' && (await ownerCount(id)) <= 1) {
      throw conflict('A brand needs at least one owner. Make someone else an owner first.');
    }
    await exec('update publisher_members set role = $3 where publisher_id = $1 and user_id = $2', [id, userId, body.role]);
    audit(req, 'brand.member_role', { kind: 'publisher', id }, { userId, from: target.role, to: body.role });
    return { ok: true, role: body.role };
  });

  app.delete('/api/studio/brands/:id/members/:userId', async (req) => {
    const id = idParam(req);
    const userId = idParam(req, 'userId');
    const u = requireUser(req);
    const leaving = userId === u.id && !isAdmin(u);
    const actor = await requireMember(req, id, leaving ? 'analyst' : 'admin');
    const target = await one<{ role: MemberRole }>('select role from publisher_members where publisher_id = $1 and user_id = $2', [id, userId]);
    if (!target) throw notFound('That person is not a member of this brand');
    if (!leaving && actor !== 'owner' && RANK[target.role] >= RANK.admin) throw forbidden('Only an owner can remove admins and owners');
    if (target.role === 'owner' && (await ownerCount(id)) <= 1) throw conflict('A brand needs at least one owner. Make someone else an owner first.');
    await exec('delete from publisher_members where publisher_id = $1 and user_id = $2', [id, userId]);
    audit(req, leaving ? 'brand.member_leave' : 'brand.member_remove', { kind: 'publisher', id }, { userId });
    return { ok: true };
  });

  app.post('/api/studio/brands/:id/invites', async (req, reply) => {
    const id = idParam(req);
    const actor = await requireMember(req, id, 'admin');
    const u = requireUser(req);
    const b = await loadBrand(id);
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address').max(200), role: z.enum(ROLES).optional() }), req.body);
    const role = body.role ?? 'editor';
    if (actor !== 'owner' && RANK[role] >= RANK.admin) throw forbidden('Only an owner can invite admins and owners');
    if (!rateLimit('team_invite', id, 30, 3600)) throw new HttpError(429, 'Too many invitations sent. Try again in an hour.');
    const already = await one(
      `select 1 from publisher_members m join users u on u.id = m.user_id where m.publisher_id = $1 and lower(u.email) = $2`,
      [id, body.email],
    );
    if (already) throw conflict('That person is already a member of this brand');
    const token = randomToken(32);
    const invite = await tx(async (db) => {
      await db.query('delete from publisher_invites where publisher_id = $1 and lower(email) = $2 and accepted_at is null', [id, body.email]);
      const ins = await db.query(
        `insert into publisher_invites (publisher_id, email, role, token_hash, invited_by, expires_at)
         values ($1,$2,$3,$4,$5, now() + interval '14 days') returning id, email, role, created_at, expires_at`,
        [id, body.email, role, sha256(token), u.id],
      );
      return ins.rows[0];
    });
    await sendTemplate(
      'team_invite',
      body.email,
      { brand: b.name, inviter: u.display_name || u.username, role, url: `${config.appUrl}/studio/invite?token=${token}` },
      { publisherId: null },
    );
    audit(req, 'brand.invite', { kind: 'publisher', id }, { email: body.email, role });
    reply.code(201);
    return { invite };
  });

  app.delete('/api/studio/brands/:id/invites/:inviteId', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const n = await exec('delete from publisher_invites where id = $1 and publisher_id = $2 and accepted_at is null', [idParam(req, 'inviteId'), id]);
    if (!n) throw notFound('Invitation not found');
    return { ok: true };
  });

  const findInvite = async (token: string) =>
    one(
      `select i.*, p.name as brand_name, p.slug as brand_slug, p.avatar_key
         from publisher_invites i join publishers p on p.id = i.publisher_id
        where i.token_hash = $1 and p.deleted_at is null`,
      [sha256(token)],
    );

  /** What an invitation is for, shown before accepting. */
  app.get('/api/studio/invites/:token', async (req) => {
    const u = requireUser(req);
    const inv = await findInvite((req.params as { token: string }).token);
    if (!inv || inv.accepted_at || Date.parse(inv.expires_at) < Date.now()) throw notFound('This invitation is no longer valid');
    return {
      invite: {
        brand: { id: inv.publisher_id, name: inv.brand_name, slug: inv.brand_slug, avatar_url: await publicUrl(inv.avatar_key) },
        role: inv.role, email: inv.email, expires_at: inv.expires_at, for_you: inv.email.toLowerCase() === u.email.toLowerCase(),
      },
    };
  });

  app.post('/api/studio/invites/accept', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    if (!rateLimit('invite_accept', u.id, 20, 600)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const inv = await findInvite(body.token);
    if (!inv || inv.accepted_at || Date.parse(inv.expires_at) < Date.now()) throw notFound('This invitation is no longer valid');
    if (inv.email.toLowerCase() !== u.email.toLowerCase()) {
      throw forbidden(`This invitation was sent to another email address. Sign in with that account to accept it.`);
    }
    await tx(async (db) => {
      await db.query(
        `insert into publisher_members (publisher_id, user_id, role) values ($1,$2,$3) on conflict (publisher_id, user_id) do nothing`,
        [inv.publisher_id, u.id, inv.role],
      );
      await db.query('update publisher_invites set accepted_at = now() where id = $1', [inv.id]);
    });
    const member = await one<{ role: MemberRole }>('select role from publisher_members where publisher_id = $1 and user_id = $2', [inv.publisher_id, u.id]);
    audit(req, 'brand.invite_accept', { kind: 'publisher', id: inv.publisher_id });
    return { ok: true, brand: { id: inv.publisher_id, name: inv.brand_name, slug: inv.brand_slug }, role: member!.role };
  });

  // ------------------------------------------------------------ conventions

  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-03-14').refine((v) => !Number.isNaN(Date.parse(v)), 'That date does not exist');
  const convention = z.object({
    name: z.string().trim().min(2).max(120),
    location: z.string().trim().max(160).optional(),
    booth: z.string().trim().max(60).optional(),
    url: link.optional(),
    starts_on: date,
    ends_on: date.nullable().optional(),
  });
  const conventionCols = 'id, name, location, booth, url, starts_on, ends_on, created_at';

  app.get('/api/studio/brands/:id/conventions', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'analyst');
    return { conventions: await q(`select ${conventionCols} from conventions where publisher_id = $1 order by starts_on desc`, [id]) };
  });

  app.post('/api/studio/brands/:id/conventions', async (req, reply) => {
    const id = idParam(req);
    await requireMember(req, id, 'editor');
    const body = parse(convention, req.body);
    if (body.ends_on && body.ends_on < body.starts_on) throw badRequest('The end date is before the start date');
    const row = await one(
      `insert into conventions (publisher_id, name, location, booth, url, starts_on, ends_on) values ($1,$2,$3,$4,$5,$6,$7) returning ${conventionCols}`,
      [id, body.name, body.location ?? '', body.booth ?? '', body.url ?? null, body.starts_on, body.ends_on ?? null],
    );
    reply.code(201);
    return { convention: row };
  });

  app.patch('/api/studio/brands/:id/conventions/:conventionId', async (req) => {
    const id = idParam(req);
    const cid = idParam(req, 'conventionId');
    await requireMember(req, id, 'editor');
    const cur = await one(`select ${conventionCols} from conventions where id = $1 and publisher_id = $2`, [cid, id]);
    if (!cur) throw notFound('Convention not found');
    const body = parse(convention.partial(), req.body);
    const next = { ...cur, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
    if (next.ends_on && next.ends_on < next.starts_on) throw badRequest('The end date is before the start date');
    const { sets, values } = patch(body, ['name', 'location', 'booth', 'url', 'starts_on', 'ends_on'], 2);
    if (!sets.length) return { convention: cur };
    return { convention: await one(`update conventions set ${sets.join(', ')} where id = $1 returning ${conventionCols}`, [cid, ...values]) };
  });

  app.delete('/api/studio/brands/:id/conventions/:conventionId', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'editor');
    const n = await exec('delete from conventions where id = $1 and publisher_id = $2', [idParam(req, 'conventionId'), id]);
    if (!n) throw notFound('Convention not found');
    return { ok: true };
  });
}
