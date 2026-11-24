# Deploying AltComix

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
create role altcomix login password 'choose-one';
create database altcomix owner altcomix;
```

## 3. First install

```bash
sudo mkdir -p /srv/altcomix && sudo chown "$USER" /srv/altcomix
git clone <repository url> /srv/altcomix && cd /srv/altcomix
cp .env.example .env && chmod 600 .env && nano .env
```

`.env` (never committed; `chmod 600`):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `4000` |
| `APP_URL` | Public origin, no trailing slash, e.g. `https://altcomix.example` |
| `DATABASE_URL` | `postgres://altcomix:PASSWORD@127.0.0.1:5432/altcomix` |
| `APP_SECRET` | 32+ random bytes: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Back it up.** It encrypts every key saved in `/admin`; lose it and they all have to be re-entered |
| `STORAGE_DIR` | Absolute path for uploaded files while storage is local, e.g. `/srv/altcomix-storage` |
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
sudo cp scripts/deploy/nginx.conf /etc/nginx/sites-available/altcomix
sudo nano /etc/nginx/sites-available/altcomix      # server_name and the /srv/altcomix path
sudo ln -s /etc/nginx/sites-available/altcomix /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d altcomix.example -d www.altcomix.example
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
   cd /srv/altcomix/api
   node --env-file=../.env src/make-admin.ts someone@example.com          # super admin
   node --env-file=../.env src/make-admin.ts someone@example.com admin    # admin
   node --env-file=../.env src/make-admin.ts someone@example.com user     # remove access
   ```

   The account must already exist. The change is written to the audit log.

Roles: an **admin** moderates and supports (users, brands, catalogue, orders
and refunds, codes, storefront, email log, error log). A **super admin** also
has settings, security, payouts, settlement, ledger and wallet adjustments,
gift cards and role changes.

## 5. Configure in /admin (in this order)

Everything here is stored encrypted in the database and never shown again
after saving. A blank secret field keeps what is stored.

1. **Security > Two-factor.** Enrol yourself, save the backup codes, then turn
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
4. **Settings > Payments.** Divinity payments: API URL, partner ID, API key,
   webhook secret; *Test connection*; register the webhook URL shown
   (`<APP_URL>/api/webhooks/divinity`) with the processor; then set the
   provider to Divinity. The sandbox provider cannot be selected in
   production, and the Health page warns while no processor is configured.
5. **Settings > Security.** reCAPTCHA keys (optional), rate limit.
6. **Pages.** The footer pages (terms, privacy, content policy and so on) ship
   as first drafts marked *Draft*, with the parts only you can answer in
   brackets. They are not legal advice. Rewrite them before launch.
7. **Health.** Should show no warnings you do not expect.

## 6. Processes

```bash
pm2 status                         # one entry: altcomix (the launcher)
pm2 logs altcomix                  # launcher + API output
pm2 sendSignal SIGHUP altcomix     # rolling reload: no dropped requests
pm2 restart altcomix --update-env  # full restart: needed after editing .env or the files in scripts/deploy
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
cd /srv/altcomix && ./scripts/deploy/deploy.sh
```

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

- **Database:** `pg_dump -Fc altcomix > altcomix-$(date +%F).dump` nightly, copied off the server.
- **Files:** `STORAGE_DIR` while storage is local; the R2 bucket afterwards.
- **`.env`**, above all `APP_SECRET`, somewhere safe and separate from the database dump.

A database dump without `APP_SECRET` restores everything except the saved
integration keys.

## 11. Monitoring

- `GET /api/health` returns 503 when the database is unreachable;
  `GET /api/health/live` only says the process is up. Point an uptime monitor at the first.
- Admin > Health: database, storage round trip, disk, email, payments, jobs, warnings.
- Admin > Error log: server, job and browser errors, grouped.
- Logs: `/var/log/pm2/altcomix-*.log`, `/var/log/nginx/`, `/var/log/botblock*.log`.
  PM2 does not rotate logs by itself: `pm2 install pm2-logrotate`.

## 12. Known limits

- **Maintenance mode** (Settings > Site) answers 503 to everything outside
  `/api/auth`, `/api/admin` and `/api/bootstrap`, including `/api/health`, so
  an uptime monitor will alert while it is on.
- **Settings changes** reach other API processes within 15 seconds (each
  caches settings briefly). Blocks and unblocks reach them within a minute.
- **Email webhooks** are accepted only with a valid provider signature; with
  no key saved they answer 503 and the provider will retry later.
