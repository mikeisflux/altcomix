# Working agreement for parallel build work

Several workers are building NSFWComix at the same time in this one checkout.
Read this before touching anything.

## Environment

- Repo: `/home/user/altcomix`. Node 26 is at `/opt/node26/bin` — put it first on
  PATH: `export PATH=/opt/node26/bin:$PATH`.
- Postgres 19 runs at `127.0.0.1:5433`, database `nsfwcomix`, user `postgres`, no
  password. Shell access: `/opt/pg19/bin/psql -h 127.0.0.1 -p 5433 -U postgres nsfwcomix`.
  `DATABASE_URL` defaults to this in development; you do not need a `.env`.
- Run migrations: `cd api && node src/migrate.ts`.
- Start your own API for testing on **your own port** with only the route files
  you need, and without background jobs unless you are testing one:
  `cd api && PORT=41xx NO_JOBS=1 ROUTES=auth,<your-prefix> node src/server.ts`
  (`ROUTES` is a comma list of filename prefixes in `api/src/routes`). Stop it
  when you finish. Never kill another worker's process; kill yours by PID.
- No outbound network except npm. Do not add dependencies unless truly needed;
  if you do, `npm install <pkg>@latest -w api` (or `-w web`).

## Code rules

- The API is TypeScript run directly by Node 26 (type stripping). That means
  **erasable syntax only**: no `enum`, no parameter properties, no namespaces;
  relative imports end in `.ts`; type-only imports use `import type`.
- `cd api && npx tsc --noEmit` must be clean for your files before you finish
  (unused locals/params are errors).
- Read first: `docs/FEATURES.md` (the spec, numbered), `api/src/migrations/*.sql`
  (schema), `api/src/lib/*.ts` (helpers), `api/src/routes/auth.ts` (the pattern
  for a route file), `api/src/server.ts` (how routes and jobs load).
- Route file: `api/src/routes/<name>.ts`, default export
  `async function (app: FastifyInstance)`. Job file: `api/src/jobs/<name>.ts`,
  default export a `Job` (`{ name, everyMs, run }`, see `jobs/email-queue.ts`).
  Both are auto-loaded; do not edit `server.ts`.
- Use the helpers: `q/one/exec/tx/patch` from `db.ts`; `parse` + zod for every
  body; `requireUser/requireMember/requireSeriesMember/requireReleaseMember/
  requireAdmin/requireSuperAdmin`, `audit`, `HttpError` and friends from
  `lib/http.ts`; `storage()`/`publicUrl()` from `lib/storage.ts`;
  `getSetting()` from `lib/settings.ts`; `sendTemplate()` from `lib/email.ts`;
  `notify()` from `lib/notify.ts`; `rateLimit()` from `lib/botblock.ts`;
  `releaseAccess()` from `lib/access.ts` for anything about who may see a page.
- Errors are `{ "error": "human sentence" }` with the right status. Write error
  messages for the person using the site.
- Every mutating `/api` call needs the `x-csrf-token` header equal to the
  `csrf_token` cookie (webhooks and cron are exempt). In curl:
  `curl -c jar -b jar .../api/bootstrap`, then send
  `-H "x-csrf-token: $(awk '/csrf_token/{print $7}' jar)"`.
- Money is integer cents. IDs are UUIDv7 (`uuidv7()` default). Soft delete with
  `deleted_at` where the column exists and always filter it.
- Schema changes: add a NEW migration file with your assigned number prefix.
  Never edit an existing migration.
- No placeholders, no fake data, no "coming soon" handlers. If part of your
  brief genuinely cannot be done, leave it out and say so in your report.
- Never write secrets, real emails, or personal data into the repo (it is
  public).
- Stay inside the files you were assigned. If you need a change in a shared
  file (`lib/*.ts` you do not own, `server.ts`, migrations 001–005), do not
  make it: describe it in your report.
- Do not `git commit`, `git add`, or switch branches. The coordinator commits.

## What to hand back

1. An endpoint reference at `docs/api/<area>.md`: for each endpoint the method,
   path, who may call it, request body/query, and the response shape (real
   field names). The web app is built from this file, so it must be accurate.
2. In your final message: what you built, how you tested it (commands and what
   you saw), the FEATURES.md item numbers you completed / partially completed /
   skipped, and anything you needed from a shared file.
