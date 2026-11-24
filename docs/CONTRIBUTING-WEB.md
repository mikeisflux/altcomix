# Working agreement for web (front-end) build work

Read `docs/CONTRIBUTING-AGENTS.md` first for the environment (Node 26 on PATH,
Postgres, no commits, stay in your files). This file adds the web rules.

## Stack and layout

React 19, Vite 8, React Router 8 (`react-router` package, data router),
TanStack Query 5, Tailwind CSS 4, lucide-react icons, sonner toasts. TypeScript
strict; `cd web && npx tsc --noEmit` must be clean (unused imports are errors).

```
web/src/
  ui/         shared components: import from '@/ui'   (do not edit)
  lib/        api.ts, session.tsx, format.ts, frames.ts, markdown.tsx (do not edit)
  layout/     AppShell (top bar, sidebar, account menu) (do not edit)
  areas/<yours>/routes.tsx   exports your route arrays; put your pages beside it
  router.tsx  already imports every area's arrays (do not edit)
```

Read these before writing anything: `web/src/ui/*.tsx` (every component you
have), `web/src/lib/api.ts`, `web/src/lib/session.tsx`, `web/src/lib/format.ts`,
`web/src/layout/AppShell.tsx` (the links it already points at — your routes
must exist at those paths), `web/src/areas/auth/routes.tsx` (the pattern for a
page), `web/src/styles.css` (design tokens).

## Rules

- **Data**: every call goes through `api()` / `upload()` from `@/lib/api`
  (they add the CSRF header). Use `useQuery`/`useMutation`; invalidate the
  right keys after a mutation; call `useSession().refresh()` when something
  about the signed-in user changes (membership, wallet, brands, prefs).
- **The API is the contract.** Endpoint references are in `docs/api/*.md` when
  present; the source of truth is the route files in `api/src/routes/`. Read
  the handler for every endpoint you call and use its real field names. Do not
  invent endpoints. If something you need is missing or broken, do NOT edit API
  files: build the screen to the handler as written, and list the gap in your
  report with the exact request that fails.
- **States**: every screen handles loading (`PageLoader`/`Skeleton`), empty
  (`EmptyState` with a next step), error (`ErrorState` with retry) and success.
  Mutations show a toast on success and the server's error message on failure,
  and disable their button while running. Destructive actions ask first with
  `useConfirm()`.
- **Design**: use the tokens and components that exist. Semantic colour
  classes only (`bg-surface`, `bg-raised`, `border-line`, `text-muted`,
  `text-accent-hover`, `bg-accent` …), never raw hex or Tailwind palette
  colours. Headings use the display font automatically. One primary button per
  view. Sentence case. Write labels and messages for the person using the
  screen: plain, specific, no jargon, no placeholder copy, no lorem ipsum.
  This is an original product: do not imitate another site's branding, layout
  or wording.
- **Responsive**: everything works from 360px wide to desktop. No horizontal
  page scroll; wide tables scroll inside `Table`. Touch targets ≥ 40px.
- **Accessible**: real `<button>`/`<a>`; labels on every input (`Field`);
  `aria-label` on icon-only buttons (`IconButton` requires it); visible focus;
  keyboard reachable.
- **Money** is integer cents: show with `money()` / `moneyExact()` and edit
  with `MoneyInput`. Dates with `date()` / `dateTime()` / `ago()`.
- **Images** from the API are URLs (often relative `/media/...`): use them as
  given, with `loading="lazy"`, explicit aspect ratio (covers are 2:3), and
  `alt` text.
- No `dangerouslySetInnerHTML`. Render Markdown with `<Markdown source=… />`
  from `@/lib/markdown`.
- No new dependencies without a strong reason. No charts library: `BarChart`,
  `RankList`, `ProgressBar`, `Stat` are in `@/ui`.
- If you need a small shared component that does not exist, put it in your own
  area folder. Do not edit `ui/`, `lib/`, `layout/`, `router.tsx`, or another
  area; if one of them needs a change, say so in your report.

## Testing your screens

Run your own servers on your assigned ports:

```bash
cd api && PORT=<api-port> NO_JOBS=1 node src/server.ts          # all routes
cd web && API_URL=http://localhost:<api-port> WEB_PORT=<web-port> npx vite
```

(Leave `NO_JOBS` off if you need background work such as page ingestion.)
`npm run seed -w api` creates a demo brand, series and releases with generated
pages if the seed script exists; otherwise create data through the API.
Other workers share the same database: create your own test accounts and
content, and do not delete rows you did not create.

Drive the real UI with Playwright (already installed: `require('playwright')`,
`chromium.launch()`), at 1280×800 and 390×800: sign up, click through every
screen you built, submit the forms, and look at the screenshots (save them in
`/tmp/claude-0/-home-user/0b8e83cf-70f0-568d-9a09-346fab754db0/scratchpad/<your-name>/`).
Fix what looks wrong: overflow, cramped or misaligned layout, unreadable
contrast, dead buttons, console errors. Stop your servers when you finish.

## What to hand back

Your final message: the routes you built, what you verified in the browser and
how, every API gap or bug you hit (endpoint, request, what happened, what you
expected), the `docs/FEATURES.md` item numbers that now work end to end /
partly / not at all, and anything you needed changed in shared files.
