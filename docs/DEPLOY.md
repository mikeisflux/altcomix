# Deploying NSFWComix

One Linux server running nginx, PM2, Node 26 and PostgreSQL 18 or newer. The
layout follows IndieCrowdfund: nginx in front, PM2 supervising the Node
processes, an iptables watcher for blocked IPs, and every integration key
entered in `/admin` rather than in files.

What has and has not been exercised: the PM2 launcher, rolling reload, cron
endpoints and firewall scripts were run in development (the firewall scripts
against a stand-in `iptables`). `nginx.conf` and `deploy.sh` have been syntax
checked only: there was no nginx and no git remote to run them against. Treat
the first production deploy as their test and read the output.

## 1. What runs where

```
Internet -> nginx :80/:443
              |-- /assets/*            files in web/dist (cached 1 year)
              |-- /api/*, /media/*     -> 127.0.0.1:4000
              `-- everything else      web/dist/index.html (the app)

PM2 -> scripts/deploy/cluster.mjs (launcher)
          |-- node api/src/server.ts   jobs + web      (1 process)
          `-- node api/src/server.ts   NO_JOBS=1, web  (WEB_CONCURRENCY - 1 processes)

root -> botblock-watcher (systemd) + botblock-sync (cron): iptables DROP rules
```

Background jobs (email queue, scheduled publishing, membership billing and
settlement, page processing, clean-up) run inside exactly one API process.
The launcher starts that one normally and gives all the others `NO_JOBS=1`.

## 2. Server preparation

```bash
# Node 26 (any method; nvm shown), PM2
nvm install 26 && npm install -g pm2
# PostgreSQL 18+ (the schema uses uuidv7()), nginx, psql client, certbot
sudo apt install postgresql nginx postgresql-client certbot python3-certbot-nginx
sudo mkdir -p /var/log/pm2 && sudo chown "$USER" /var/log/pm2
```

Database:

```sql
create role nsfwcomix login password 'choose-one';
create database nsfwcomix owner nsfwcomix;
```

## 3. First install

```bash
sudo mkdir -p /srv/nsfwcomix && sudo chown "$USER" /srv/nsfwcomix
git clone <repository url> /srv/nsfwcomix && cd /srv/nsfwcomix
cp .env.example .env && chmod 600 .env && nano .env
```

`.env` (never committed; `chmod 600`):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `4000` |
| `APP_URL` | Public origin, no trailing slash, e.g. `https://nsfwcomix.com` |
| `DATABASE_URL` | `postgres://nsfwcomix:PASSWORD@127.0.0.1:5432/nsfwcomix` |
| `APP_SECRET` | 32+ random bytes: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Back it up.** It encrypts every key saved in `/admin`; lose it and they all have to be re-entered |
| `STORAGE_DIR` | Absolute path for uploaded files while storage is local, e.g. `/srv/nsfwcomix-storage` |
| `SUPER_ADMIN_EMAIL` | Your email. The account registered with it becomes super admin |
| `CRON_SECRET` | Long random string. Leave empty to disable the `/api/cron` endpoints |
| `WEB_CONCURRENCY` | Optional. API processes to run (default 4, see section 6) |

Then:

```bash
npm ci
npm run build          # web client -> web/dist
npm run migrate        # creates the schema
pm2 start scripts/deploy/ecosystem.config.cjs
pm2 save && pm2 startup    # run the command it prints, so PM2 comes back after a reboot
curl -s localhost:4000/api/health
```

nginx:

```bash
sudo cp scripts/deploy/nginx.conf /etc/nginx/sites-available/nsfwcomix
sudo nano /etc/nginx/sites-available/nsfwcomix      # server_name and the /srv/nsfwcomix path
sudo ln -s /etc/nginx/sites-available/nsfwcomix /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d nsfwcomix.com -d www.nsfwcomix.com
```

The API works out each visitor's address from the **last** `X-Forwarded-For`
entry, which is the one nginx adds. The bot blocker, rate limits and login
audit depend on it. If Cloudflare or another proxy sits in front of nginx,
enable the `real_ip` block in `nginx.conf` first; otherwise every visitor
appears to come from the proxy and a single block shuts everyone out.

## 4. First admin

1. Open the site and register with the address in `SUPER_ADMIN_EMAIL`. That
   account is a super admin from the start.
2. To promote anyone later, from the server:

   ```bash
   cd /srv/nsfwcomix/api
   node --env-file=../.env src/make-admin.ts someone@example.com          # super admin
   node --env-file=../.env src/make-admin.ts someone@example.com admin    # admin
   node --env-file=../.env src/make-admin.ts someone@example.com user     # remove access
   ```

   The account must already exist. The change is written to the audit log.

Roles: an **admin** moderates and supports (users, brands, catalog, orders
and refunds, codes, storefront, email log, error log). A **super admin** also
has settings, security, payouts, settlement, ledger and wallet adjustments,
gift cards and role changes.

## 5. Configure in /admin (in this order)

Everything here is stored encrypted in the database and never shown again
after saving. A blank secret field keeps what is stored.

1. **Security > Two-factor.** Enroll yourself, save the backup codes, then turn
   on *Require 2FA for admins* in Settings > Security. Lost device: another
   super admin can reset it; if there is none, clear it in the database:
   `update users set totp_enabled = false, totp_secret = null where email = '...'`.
2. **Settings > Storage.** Cloudflare R2 account ID, bucket, access key ID and
   secret; press *Test connection*; then switch the driver to R2. Switching
   does not move existing files: copy `STORAGE_DIR` into the bucket first
   (same keys). Set the public URL to the bucket's custom domain so covers and
   free pages are served from the CDN.
3. **Settings > Email.** SendGrid (API key with Mail Send) or Mailgun (API key
   and domain), the From address, *Test connection*, then *Send test email*.
   Register the webhook URL shown on the page with the provider and paste its
   verification key (SendGrid: Signed Event Webhook public key; Mailgun: HTTP
   webhook signing key). Until a key is saved the webhook refuses everything.
   **Inbound mail** (same tab, optional): lets people write to
   `support@<domain>`, `dmca@<domain>` and so on, and puts that mail in
   Admin > Inbox. It uses SendGrid Inbound Parse.

   > Pointing a domain's MX record at SendGrid sends **all** mail for that
   > domain to this site. If the domain already has mailboxes elsewhere
   > (Google Workspace, Microsoft 365, the web host), they stop receiving the
   > moment the record changes. To keep them, receive on a subdomain instead
   > (for example `mail.<domain>`) and publish addresses on that.

   1. Get the address SendGrid will post to. Either press *Turn on incoming
      mail* (the server makes a 43-character secret and shows the full
      address with a copy button), or, if an address has already been handed
      out, paste its last part into *Secret part of the address* and save.
      Before anyone can sign in to /admin, the same can be done from the
      shell:

      ```bash
      cd /srv/nsfwcomix/api
      node --env-file=../.env src/set-inbound-token.ts <token>      # 32+ characters: letters, digits, - and _
      node --env-file=../.env src/set-inbound-token.ts --generate   # or let it make one and print the address
      ```

      The address is `<APP_URL>/api/webhooks/email/inbound/<secret>`. The
      secret is the only thing protecting it (SendGrid does not sign these
      requests): treat it like a password. *Make a new address* replaces it;
      the old one stops working within 15 seconds.
   2. SendGrid > Settings > Sender Authentication: authenticate the domain.
   3. DNS: add an `MX` record for the receiving host with value
      `mx.sendgrid.net` and priority `10`, and remove other MX records for
      that host.
   4. SendGrid > Settings > Inbound Parse > *Add Host & URL*: choose the
      domain and paste the address as the destination URL. Leave *POST the
      raw, full MIME message* **unticked**. Tick *Check incoming emails for
      spam* (mail scored 5 or higher goes to the spam tab).
   5. Send a test message to `support@<domain>`. A *Support* mailbox is
      created by itself for the first message; add the others (`dmca@` ...)
      under Admin > Inbox > Mailboxes. Mail for an address without a mailbox
      lands in the catch-all mailbox.

   Mail is accepted only for the host in `APP_URL`, the domain of the From
   address, and their subdomains. Replies go out through the normal email
   queue from the mailbox's own address, so that domain must be the
   authenticated one. `scripts/deploy/nginx.conf` has a `location` for the
   webhook that allows 40 MB bodies (a message with 25 MB of attachments is
   about 34 MB once encoded) and keeps these requests out of the access log,
   because the address contains the secret. If a proxy or CDN in front of
   nginx logs URLs, exclude this path there too.
4. **Settings > Payments.** Divinity payments: API URL, partner ID, API key,
   webhook secret; *Test connection*; register the webhook URL shown
   (`<APP_URL>/api/webhooks/divinity`) with the processor; then set the
   provider to Divinity. The sandbox provider cannot be selected in
   production, and the Health page warns while no processor is configured.
   **Embedded checkout:** desktop readers pay inside a dialog on this site
   with the processor's card form framed in it. The processor only lets
   allow-listed sites frame that page: ask Divinity to add this site's exact
   origin (shown, copyable, under *Embedded checkout* on the same tab) to its
   `CHECKOUT_FRAME_ANCESTORS` setting. Until they have, desktop readers get an
   empty frame, so turn *Show the card form inside this site* off (everyone is
   then sent to the checkout page and back) and switch it on once Divinity
   confirms. Nothing this site sends blocks the frame: there is no
   Content-Security-Policy, and the `X-Frame-Options` / `Permissions-Policy`
   headers in `scripts/deploy/nginx.conf` only govern who may frame *us* and
   the camera, microphone and location features. If a Content-Security-Policy
   is ever added, it needs `frame-src` for the processor's origin.
5. **Settings > Security.** reCAPTCHA keys (optional), rate limit.
6. **Pages.** The footer pages (terms, privacy, content policy and so on) ship
   as first drafts marked *Draft*, with the parts only you can answer in
   brackets. They are not legal advice. Rewrite them before launch.
7. **Health.** Should show no warnings you do not expect.

### Creator taxes

- **The limit is yours to set, with your accountant.** Settings > Revenue >
  *Tax reporting limit (per calendar year)* ships at $2,000 as a starting
  value, not as advice. *Require the tax information form* is on by default.
- When a brand's earnings in a calendar year reach the limit, its owners are
  told in the Studio and by email (template `tax_form_needed`, editable under
  Email > Templates) and sent to a form that collects who is being paid, their
  address, tax classification and taxpayer ID, with a typed signature. The
  brand cannot request a payout until the form is on file. Approving or paying
  an existing request is not blocked; the Payouts screen shows a warning.
- Admin > Creator taxes lists every brand for a year and exports the brands
  over the limit as a CSV for your accountant. Full taxpayer IDs are only in
  the file when a super admin ticks the box and confirms, and both that export
  and every on-screen reveal of an ID are written to the audit log.
- **The site collects the information and exports it. It does not file
  anything with the IRS and does not generate the IRS form itself.** Preparing
  and sending the forms is done by you or your accountant from the export.
- Taxpayer IDs are encrypted with `APP_SECRET`. If `APP_SECRET` is changed or
  lost, the stored IDs cannot be read and every brand has to submit its form
  again. Back it up with the database.
- The certification wording creators sign is in `api/src/lib/tax.ts`
  (`CERTIFICATIONS`). Have your accountant or lawyer read it before launch.
- The notice is sent by the in-process `tax-notices` job (every 10 minutes).
  It has no `/api/cron` endpoint, so it needs the jobs process running.

### Sales tax

- **Off by default.** A new install charges no tax and asks no buyer where
  they are. Nothing changes until you turn it on under Settings > Sales tax.
- **The rates are yours to set, with your accountant.** They decide in which
  states you must collect and at what rate. Enter a rate only for those
  states; every state starts at 0% and stays there until you change it. The
  site knows one rate per state: it does not look up county or city rates, and
  it does not know the tax rules of any state. Rates are stored in hundredths
  of a percent, so 7% and 6.25% can be entered but 6.625% cannot.
- With it on, checkout asks for the buyer's country and, in the United States,
  their state and ZIP code, and adds the tax as its own line before they pay.
  Buyers outside the United States are not charged. The location is whatever
  the buyer enters; it is not checked against their card or their network
  address.
- Taxed: comics (releases, downloads, whole series, bundles), page-credit
  packs and memberships (the first payment and every renewal, at the member's
  saved state). Not taxed: tips and gift cards.
- **No tax is charged on store credit.** Tax is worked out only on the part of
  a taxed purchase the buyer pays by card. Store credit (including redeemed
  gift cards) is applied to the taxed items first, and an order fully paid
  with credit owes no tax. Sales paid with store credit are therefore not in
  the report's "taxable sales". Ask your accountant whether that treatment is
  right for the states you collect in.
- **The tax is not revenue and not creator money.** Creator earnings, revenue
  splits, the membership pool, processing-fee estimates and the sales figures
  in admin are all worked out on the price before tax. The payment processor's
  fee on the tax portion of a charge is the platform's cost.
- Members who joined before you turned sales tax on have no saved location and
  are not taxed at renewal until they add one on their Membership page.
- Finance > Sales tax shows, for any date range (it opens on the last full
  month), taxable sales, tax collected, tax refunded and net tax per state,
  and exports them as a CSV. Dates are in UTC.
- **The site collects the tax and reports it. It does not register you with
  any state, file returns or pay the states.** That is done by you or your
  accountant from the report.
- Changing a rate affects orders and membership charges created from then on;
  it never changes what an existing order was charged.
- The Terms page says prices do not include sales tax (migration
  `088_terms_sales_tax.sql`; fresh installs get the same sentence from the
  seed). If you have rewritten that sentence yourself, the migration leaves
  your text alone: add the wording by hand under Pages.

### Creator Premium

An optional yearly plan a brand can buy in its Studio. Nothing needs to be
switched on: it is offered as soon as payments work.

- **Migrations** `089_creator_premium.sql` and `090_premium_grants.sql` add the
  tables and append a "Creator Premium" section to the publisher terms page
  (only if the page does not already mention it; fresh installs get it from the
  seed). Read that section in Admin > Pages: it states the price as 140.00 a
  year. **If you change the price, edit the page too**; the page is not updated
  from the setting.
- **Price and name**: Admin > Settings > Creator Premium (default 140.00 a
  year per brand, before sales tax). A new price applies to brands that
  subscribe from then on; a brand already subscribed renews at the price it
  started at.
- **What it gates**: the "Buy in print" link on releases, and the advanced
  analytics (where readers stop, countries, followers, engagement, email
  statistics, all CSV exports). Everything else stays free. Links saved before
  are kept and simply not shown to readers until the brand has Premium, so
  **on the day this is deployed every existing print link disappears from the
  public pages** until its brand subscribes or you grant it Premium.
- **Granting it for free**: Admin > Finance > Creator Premium > Grant, or the
  same button on a brand's admin page. Choose an end date (one year by
  default) or no end date, and optionally a note. No card, no charge, no tax,
  not revenue. The owners get a notification and an email. You can change the
  end date or revoke it at any time; each step is in the audit log. A grant and
  a paid plan can run together: the features stay on while either is active.
- **Billing** uses the same background job as the reader membership (section
  8, `memberships`): renewal once a year on the saved card, a declined card
  retried after 1, 3 and 5 days, then the plan ends. As with the reader
  membership, the features are off from the end of the paid year until the
  renewal is paid. The job must be running for renewals and for grants to end
  on their end date.
- **Sales tax**: when sales tax is on (above), Premium is taxed like a
  membership charge at the paying person's billing location, on the first
  payment and each renewal, and appears in Finance > Sales tax.
- **Money**: Premium is platform revenue. It has its own line on the admin
  dashboard (before tax) and is included in "Money in" and "Platform revenue".
  It is never part of the membership pool, a creator's ledger or the
  membership figures.
- **Refunds**: the site's policy is that all sales are final. An admin can
  still refund a payment in full (Finance > Creator Premium > Payments); that
  returns the tax and ends the brand's paid plan at once.
- **Processor**: Premium charges are sent to the processor under the same
  project id as membership charges (`nsfwcomix-membership`), with the
  description "Creator Premium for <brand> (1 year)". It has been tested
  against the sandbox and a local stand-in for the processor only, not against
  the live processor.
- **Emails** (Admin > Email > Templates): `premium_started`, `premium_billing`,
  `premium_granted`.

## 6. Processes

```bash
pm2 status                         # one entry: nsfwcomix (the launcher)
pm2 logs nsfwcomix                  # launcher + API output
pm2 sendSignal SIGHUP nsfwcomix     # rolling reload: no dropped requests
pm2 restart nsfwcomix --update-env  # full restart: needed after editing .env or the files in scripts/deploy
```

- `WEB_CONCURRENCY` sets how many API processes run (default 4, or the number
  of CPU cores if lower). Each can hold 20 database connections, so keep
  `WEB_CONCURRENCY x 20` below PostgreSQL's `max_connections` (100 by default)
  with room for the firewall sync and your own sessions.
- If a process dies the launcher replaces it, backing off if it keeps dying
  at start-up. If the launcher itself dies, PM2 restarts it.
- A rolling reload starts each replacement and waits for it to accept
  connections before stopping the old one. If the new code cannot start, the
  reload stops and the old processes keep serving; the launcher log says
  `rolling reload ABORTED`.
- PM2's own cluster mode is not used: it does not run `server.ts` as the main
  module, so the server would never start listening.

## 7. Deploying an update

```bash
cd /srv/nsfwcomix && ./build-and-swap.sh
```

`build-and-swap.sh` is the script to use day to day. It asks which branch to
pull, installs dependencies only when the lockfile changed, type-checks,
builds the web app beside the live one, applies database migrations, swaps
the build in and does a rolling reload. `--branch NAME` skips the question.
The older `scripts/deploy/deploy.sh` does the same job without the branch
prompt or the side-by-side build.

Pull (fast-forward only; refuses if the checkout has local changes) → `npm ci`
→ build the web client → run migrations → rolling reload → wait for
`/api/health`. It stops at the first failure, and only the last step touches
the running site.

- `--no-pull` deploys the checkout as it is.
- `--restart` does a full restart instead of a rolling reload.
- Migrations run while the old code is still serving, so a migration must be
  compatible with the previous version (add columns first, remove them a
  release later).
- Going back: `git checkout <previous commit> && ./scripts/deploy/deploy.sh --no-pull`.
  Migrations are not reversed.

## 8. Scheduled work

Nothing needs a crontab by default: the jobs process does it all. The
`/api/cron/*` endpoints exist for running with jobs switched off, or as a
second trigger. They need `Authorization: Bearer $CRON_SECRET` and refuse
every call while `CRON_SECRET` is unset. `scripts/deploy/crontab.example` has
ready-made lines and shows how to keep the secret out of the crontab.

Admin > Cron runs shows what ran and when (in-process jobs only record runs
that did something).

## 9. Firewall blocking

Optional but recommended on a server that faces the internet directly:
`scripts/botblock/README.md`. Skip it behind Cloudflare, where the packets
come from Cloudflare's addresses and an iptables rule for the visitor would
never match; the API-level block still applies.

## 10. Backups

- **Database:** `pg_dump -Fc nsfwcomix > nsfwcomix-$(date +%F).dump` nightly, copied off the server.
- **Files:** `STORAGE_DIR` while storage is local; the R2 bucket afterwards.
- **`.env`**, above all `APP_SECRET`, somewhere safe and separate from the database dump.

A database dump without `APP_SECRET` restores everything except the saved
integration keys.

## 11. Monitoring

- `GET /api/health` returns 503 when the database is unreachable;
  `GET /api/health/live` only says the process is up. Point an uptime monitor at the first.
- Admin > Health: database, storage round trip, disk, email, payments, jobs, warnings.
- Admin > Error log: server, job and browser errors, grouped.
- Logs: `/var/log/pm2/nsfwcomix-*.log`, `/var/log/nginx/`, `/var/log/botblock*.log`.
  PM2 does not rotate logs by itself: `pm2 install pm2-logrotate`.

## 12. Known limits

- **Maintenance mode** (Settings > Site) answers 503 to everything outside
  `/api/auth`, `/api/admin` and `/api/bootstrap`, including `/api/health`, so
  an uptime monitor will alert while it is on.
- **Settings changes** reach other API processes within 15 seconds (each
  caches settings briefly). Blocks and unblocks reach them within a minute.
- **Email webhooks** are accepted only with a valid provider signature; with
  no key saved they answer 503 and the provider will retry later.
- **Inbound mail** is authenticated only by the secret in its address, because
  SendGrid Inbound Parse does not sign requests. Whoever has the address can
  put mail in the inbox (not read any). Replies thread by `References` and,
  failing that, by subject and correspondent: SendGrid assigns its own
  Message-ID to what the site sends, so an answer to a brand-new message
  written in /admin is matched by subject. Inbound mail has not been tested
  against real SendGrid delivery, only against requests shaped like its
  documented format.

## Link previews (social sharing)

`web/index.html` carries the default preview tags with full `https://nsfwcomix.com/...`
addresses, so the home page previews correctly however it is served. Per-page previews
(a series' own title, description and picture at `/share/series/<slug>.png`) need nginx to
pass page requests to the API: that is the `location /` + `location @app` pair in
`scripts/deploy/nginx.conf`. Adult series show a blurred cover under an "18+ inside" bar.
Re-render the graphics with `NODE_PATH=$(npm root -g) node web/scripts/brand-assets.mjs`.

### Creator Premium: renewals

- A reminder email goes to the payer 7 days before each yearly charge (date, amount with tax, how to cancel). One per renewal.
- If the renewal is declined, the card is retried after 1, 3 and 5 days. The brand keeps Premium during the retries; it ends when the fourth try fails.
- Subscribers renew at the price they started at. A new price in /admin applies to new subscriptions only.
