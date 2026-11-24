# NSFWComix

A digital comics platform: readers get a frame-by-frame reader that fits any
screen, creators get free publishing with a fast frame editor, direct sales
and a membership that pays by what each member actually reads.

- **API** — Node 26, Fastify 5, PostgreSQL 19, TypeScript run natively (no build step)
- **Web** — React 19, Vite 8, React Router 8, Tailwind CSS 4
- **Storage** — local disk in development, Cloudflare R2 in production
- **Email** — SendGrid or Mailgun, chosen in `/admin`
- **Payments** — Divinity payments (hosted checkout), configured in `/admin`

What is built, and what is not yet, is tracked item by item in
[`docs/FEATURES.md`](docs/FEATURES.md).

## Run it locally

Requires Node 26+ and PostgreSQL 18+ (the schema uses `uuidv7()`).

```bash
createdb nsfwcomix
cp .env.example .env        # set DATABASE_URL and APP_SECRET
npm install
npm run migrate
npm run dev:api             # API on :4000 (runs migrations on start)
npm run dev:web             # web on :5173, proxies /api and /media to :4000
```

Create the first admin by setting `SUPER_ADMIN_EMAIL` in `.env` before
registering with that address, or promote an existing account:

```bash
node api/src/make-admin.ts you@example.com
```

Then sign in and open `/admin` to enter storage, email and payment settings.
Integration keys are stored encrypted in the database (keyed by `APP_SECRET`),
never in the repository.

`npm run seed` creates a demo brand and series with generated pages.

## Layout

```
api/src/
  server.ts        Fastify app; auto-loads routes/*.ts and jobs/*.ts
  migrations/      plain SQL, applied in filename order
  lib/             access (paywall rules), auth, storage, email, settings,
                   botblock, payments, ledger, ingest, panels (frame detection)
  routes/          auth, catalog, reader, library, social, account, commerce,
                   studio-*, admin-*, content, cron, webhooks
  jobs/            email queue, page ingestion, scheduled publishing,
                   memberships, monthly settlement, cleanup
web/src/
  ui/              shared components        layout/   app shell
  lib/             API client, session, frames maths
  areas/           store, reader, account, studio, admin, auth
docs/              FEATURES.md, api/*.md (endpoint reference), DEPLOY.md
scripts/           botblock (firewall watcher), deploy (PM2, nginx)
```

## How the money works

- **Direct sales**: the creator share of each sale (default 85%) is credited
  to the brand's ledger after payment fees.
- **Membership**: each member's monthly fee, after fees, is split among the
  series *that member* read that month, in proportion to pages read. A member
  who read nothing premium contributes to a pool shared by all membership
  reading, so the creator share (default 80%) is always paid out in full.
- **Tips**: default 95% to the creator.

Shares are set in `/admin` and can be overridden per brand. There is no paid
creator tier.

## Frames

Every page can carry an ordered list of reading frames. The reader's guided
view shows one frame at a time, scaled to the screen, which is what makes a
print-layout comic readable on a phone. Creators set frames in Studio with
rectangle, point-by-point and smart tools, or detect them for a whole release
in one step. Detection is classical image analysis of panel gutters; NSFWComix
does not use generative AI and does not accept AI-generated comics.
