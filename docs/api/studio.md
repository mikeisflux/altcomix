# Studio API (`/api/studio/...`)

Everything a creator does: brands, series, releases, uploads and pages, the
frame editor, codes / bundles / discounts, analytics, earnings.

Source: `api/src/routes/studio-*.ts`, `api/src/lib/ingest.ts`,
`api/src/lib/panels.ts`, `api/src/jobs/ingest.ts`,
`api/src/jobs/publish-scheduled.ts`, migration `010_studio.sql`.

## Conventions

- All routes need a signed-in user. Mutating calls need `x-csrf-token`.
- Errors are `{ "error": "sentence", "code"?: "validation" }`. 400 bad input,
  401 not signed in, 403 wrong role, 404 unknown id (also for ids that are not
  uuids), 409 conflict, 413 upload too large, 429 rate limited.
- **Roles** (`owner > admin > editor > analyst`; platform admins count as owner).
  "Who" below is the minimum role in the brand that owns the object.
  - analyst: read everything, including analytics
  - editor: series, releases, pages, frames, conventions, contributors
  - admin: brand identity, images, payout details, team, codes, bundles,
    discounts, revenue splits, earnings, payouts, deleting a series or a
    release that has been published
  - owner: delete the brand, change admins/owners
- Money is integer cents. Shares are basis points (`2500` = 25%).
- Timestamps are ISO 8601 UTC. Dates are `YYYY-MM-DD`.
- PATCH bodies are partial: send only what changed. `null` clears a nullable field.
- Vocabularies (genres, themes, release kinds, languages, crowdfunding
  services, contributor roles ...) come from `GET /api/bootstrap` → `meta`.
- Image uploads are `multipart/form-data` with one file field (any name);
  PNG, JPG or WebP. Anything that does not decode as an image is a 400.
- URLs returned for public images (`cover_url`, `avatar_url` ...) are ready to
  use in `<img>`. Page images are private: use the `/api/studio/pages/:id/image/:variant` URLs (cookie auth).

---

## 1. Brands — `studio-brands.ts`

### Brand object

```
{ id, slug, name, kind: "creator"|"publisher", kind_requested: "creator"|"publisher"|null,
  bio, avatar_url, banner_url, website, socials: { x?, facebook?, instagram?, bluesky?, youtube?, discord?, tiktok? },
  country, timezone, primary_language, ga_tracking_id, membership_note, tips_enabled,
  monthly_goal_cents, verified, suspended, suspend_reason, payout_configured, created_at,
  role }            // role = your role in this brand
```

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/brands` | any user | `{ brands: [Brand + series_count, member_count] }` — brands you belong to |
| POST | `/api/studio/brands` | any user | Body: `name` (required) + any identity field. You become `owner`. 201 `{ brand }`. `slug` optional (3-60 `[a-z0-9-]`; 409 if taken), otherwise derived from the name. 5 per hour. |
| GET | `/api/studio/brands/:id` | analyst | `{ brand: Brand + series_count, member_count, follower_count }` |
| PATCH | `/api/studio/brands/:id` | admin | Identity fields below. `{ brand }` |
| DELETE | `/api/studio/brands/:id` | owner | Soft-deletes the brand and its series. 409 while the ledger balance is positive. |
| POST | `/api/studio/brands/:id/avatar` | admin | multipart image → 400×400 webp. `{ avatar_url }` |
| DELETE | `/api/studio/brands/:id/avatar` | admin | `{ ok }` |
| POST | `/api/studio/brands/:id/banner` | admin | multipart image → 1600×400 webp. `{ banner_url }` |
| DELETE | `/api/studio/brands/:id/banner` | admin | `{ ok }` |

Identity fields (POST / PATCH): `name` (2-80), `slug`, `bio` (≤400),
`kind` (`creator`/`publisher`), `country` (2 letters or null),
`primary_language` (language code), `timezone` (IANA name or null),
`ga_tracking_id` (`G-XXXX` / `UA-1234-1`, `""` or null clears),
`membership_note` (≤1000), `website` (https link, `""`/null clears),
`socials` (object, replaces the whole object; empty values dropped),
`tips_enabled` (bool), `monthly_goal_cents` (int or null).

`kind` is a **request**: sending a kind different from the current one sets
`kind_requested` and leaves `kind` alone until a platform admin approves it.
Sending the current kind cancels a pending request.

### Payout details

Stored in `publishers.payout` as `{ method, destination, legal_name, updated_at }`.
The destination is never returned in full.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/brands/:id/payout` | admin | `{ payout: { configured, method, legal_name, destination_hint, updated_at }, methods: ["paypal","wise","bank_transfer"] }` — `destination_hint` is masked (`p••••••@ink.example`, `••••1234`) |
| PUT | `/api/studio/brands/:id/payout` | admin | Body `{ method, destination (5-200), legal_name (2-120) }`. For `paypal`/`wise` the destination must be an email address. `{ payout }` as above |

### Team

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/brands/:id/members` | analyst | `{ members: [{ user_id, username, display_name, avatar_url, role, created_at, email?, is_you }], invites: [{ id, email, role, created_at, expires_at, invited_by }], roles: ["owner","admin","editor","analyst"], your_role }`. `email` and `invites` only for admin and up. |
| PATCH | `/api/studio/brands/:id/members/:userId` | admin | Body `{ role }`. Only an owner may touch admins/owners or grant those roles. 409 if it would leave no owner. `{ ok, role }` |
| DELETE | `/api/studio/brands/:id/members/:userId` | admin, or yourself | Removing yourself = leave the brand. 409 if it would leave no owner. |
| POST | `/api/studio/brands/:id/invites` | admin | Body `{ email, role? = "editor" }`. Sends the `team_invite` email with a link to `{APP_URL}/studio/invite?token=…` (valid 14 days). Re-inviting replaces the earlier invite. 409 if already a member. 201 `{ invite: { id, email, role, created_at, expires_at } }` |
| DELETE | `/api/studio/brands/:id/invites/:inviteId` | admin | Cancel a pending invite |
| GET | `/api/studio/invites/:token` | any user | `{ invite: { brand: { id, name, slug, avatar_url }, role, email, expires_at, for_you } }` — `for_you` is false when the signed-in account's email differs. 404 if used/expired. |
| POST | `/api/studio/invites/accept` | the invited user | Body `{ token }`. The signed-in email must match the invited one (403 otherwise). `{ ok, brand: { id, name, slug }, role }` |

### Conventions

Convention: `{ id, name, location, booth, url, starts_on, ends_on, created_at }`.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/brands/:id/conventions` | analyst | `{ conventions }`, newest first |
| POST | `/api/studio/brands/:id/conventions` | editor | `{ name, starts_on, location?, booth?, url?, ends_on? }` → 201 `{ convention }` |
| PATCH | `/api/studio/brands/:id/conventions/:conventionId` | editor | partial → `{ convention }` |
| DELETE | `/api/studio/brands/:id/conventions/:conventionId` | editor | `{ ok }` |

---

### Open a brand by its address (members and platform admins)

`GET /api/studio/brands/by-slug/:slug` (any member; platform admins even when not a member)

`{ brand }`: the brand object with `series_count`, `member_count`, `follower_count`, plus
`member_role` (the caller's real team role, or `null`) and `viewing_as_admin` (`true` for a platform admin who is not on the team).
`role` is the effective role: a platform admin always gets `owner`, as everywhere else in the Studio. 403 for a signed-in
non-member, 404 when no brand has that address. The Studio web app loads the brand for `/studio/:brand` with this call.

### Deleting a brand

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/studio/brands/:id/deletion` | owner | `{ balance_cents, open_payouts, open_payout_cents, series_count, published_release_count, owned_copies, usable_codes, can_delete, blockers: string[] }`. What deleting would take with it, and why it is refused if it is. |
| DELETE | `/api/studio/brands/:id` | owner | Soft-deletes the brand and all of its series. **409** while money is owed: a positive ledger balance (pending included), or a payout in `requested` / `approved`. `{ ok: true }` |

Effects of a delete (all enforced elsewhere by `deleted_at` filters): the series leave the store, search, brand page and direct
links; releases readers bought or redeemed leave their libraries and can no longer be read or downloaded; unlock codes for those
series stop redeeming; the team loses Studio access; the slug is not freed. Ledger and payout rows are kept.

### Confirmed email

`POST /api/studio/brands`, `POST /api/studio/releases/:id/publish` (publish or schedule),
`POST /api/studio/brands/:id/announcements` (and `/test`), `POST /api/studio/brands/:id/code-batches/:batchId/email` and
`POST /api/studio/brands/:id/payouts` answer **403** `{ "error": "Confirm your email to publish", "code": "email_unverified" }`
when the signed-in account's email is not confirmed (`requireVerifiedEmail` in `lib/ingest.ts`). Drafting, uploading and editing
are not affected. The web app shows a prompt with "Resend confirmation email" (`POST /api/auth/resend-verification`).

## 2. Series — `studio-series.ts`

### Series object

```
{ id, publisher_id, slug, title, description, type, layout, reading_dir, language, status, visibility,
  genre, themes[], audiences[], art_styles[], advisories[], eras[], content_ratings[], tags[], mature,
  cover_url, cover_thumb_url, banner_url,
  access_model, in_subscription, free_preview, paywall_expires_days, default_price_cents,
  allow_comments, update_frequency, website, pub_year, crowdfunding, forum_enabled, forum_description,
  favorite_count, follower_count, read_count, takedown: { at, reason } | null, created_at, updated_at }
```

Editable fields (create and PATCH):

| Field | Values |
|---|---|
| `title` | 1-150 (required on create) |
| `description` | ≤1800 |
| `language` | language code; default = brand's primary language |
| `pub_year` | int or null |
| `status` | `ongoing` `completed` `hiatus` `cancelled` |
| `type` | `comic` `graphic_novel` `manga` `webcomic` (on create, `manga` defaults `reading_dir` to `rtl`, `webcomic` defaults `layout` to `vertical`) |
| `layout` | `paged` `vertical` |
| `reading_dir` | `ltr` `rtl` |
| `visibility` | `draft` `public` `unlisted` |
| `genre` | one of meta.genres, or null |
| `themes` | ≤6 of meta.themes |
| `art_styles` | ≤2 of meta.artStyles |
| `audiences` | ≤3 of meta.audiences |
| `advisories`, `eras`, `content_ratings` | from meta |
| `tags` | ≤20 strings ≤30 chars (lower-cased, de-duplicated) |
| `mature` | bool |
| `access_model` | `blocked` `free` `premium` |
| `in_subscription` | bool: readable with a membership |
| `free_preview` | `{ mode, n?, m? }` — `first_releases` (first 3), `first_last_releases` (first and last 3), `first_pages` (first `n` pages of each release, default 10), `custom_first` (first `n` releases; `n` required), `custom_first_last` (first `n` and last `m`; `m` defaults to `n`), `automatic` (first release free + first 5 pages of the rest) |
| `paywall_expires_days` | int 1-3650 or null: a release becomes free this many days after publication |
| `default_price_cents` | int or null: read-online price for releases without their own |
| `allow_comments` | bool |
| `update_frequency` | one of meta.updateFrequencies or null |
| `website` | https link or null |
| `crowdfunding` | null, or `{ enabled, service (meta.crowdfundingServices), goal_cents?, url?, timezone?, starts_at?, ends_at? }` — `url` required when `enabled` |
| `forum_enabled` | bool |
| `forum_description` | ≤400 |

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/brands/:id/series` | analyst | `{ series: [{ id, slug, title, type, language, status, visibility, access_model, genre, mature, cover_url, cover_thumb_url, missing_cover, release_count, published_count, page_count, follower_count, favorite_count, read_count, taken_down, created_at, updated_at }] }` |
| POST | `/api/studio/brands/:id/series` | editor | JSON body of fields, **or** multipart with a `data` field (the same JSON as a string) and an optional `cover` file. 201 `{ series }` |
| GET | `/api/studio/series/:id` | analyst | `{ series, brand: { id, slug, name }, languages: [{ code, primary, releases }], editions, country_rules, contributors, moderators, splits, revenue_share: { sale_bps, subscription_bps, tip_bps, split_out_bps } }` — `revenue_share` is this brand's live share of each kind of money; `split_out_bps` is how much of that goes on to collaborators |
| PATCH | `/api/studio/series/:id` | editor | partial fields → `{ series }` |
| DELETE | `/api/studio/series/:id` | admin | soft delete |
| POST | `/api/studio/series/:id/cover` | editor | multipart image → `{ cover_url, cover_thumb_url }` (800w and 320w webp) |
| POST | `/api/studio/series/:id/banner` | editor | multipart image → 1920×600 webp, `{ banner_url }` |
| DELETE | `/api/studio/series/:id/banner` | editor | `{ ok }` |

A series with no cover takes page 1 of the first release that is published,
so `missing_cover` clears itself.

### Language editions

Edition: `{ language, title, description, access_model: "blocked"|"free"|"premium"|null, created_at }`
(`access_model` null = same as the series).

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/series/:id/editions` | analyst | `{ primary_language, editions }` |
| PUT | `/api/studio/series/:id/editions/:language` | editor | Create or update. `{ title, description?, access_model? }` → `{ edition }`. Fields left out keep their value on update. |
| DELETE | `/api/studio/series/:id/editions/:language` | editor | 409 while the edition still has releases |

Creating a release in a new language creates its edition automatically (with the series title).

### Country rules

Rule: `{ id, country, language: string|null, rule: "blocked"|"free"|"premium", enabled, created_at }`
(`language` null = every edition).

| Method | Path | Who |
|---|---|---|
| GET | `/api/studio/series/:id/country-rules` → `{ country_rules }` | analyst |
| POST | `/api/studio/series/:id/country-rules` `{ country, rule, language?, enabled? }` → 201 `{ country_rule }` (409 if that country+language already has one) | editor |
| PATCH | `/api/studio/series/:id/country-rules/:ruleId` → `{ country_rule }` | editor |
| DELETE | `/api/studio/series/:id/country-rules/:ruleId` | editor |

### Contributors

Contributor: `{ id, release_id: string|null, name, role, position, user_id, username }`.
`release_id` null = credited on the series; otherwise on that release.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/series/:id/contributors` | analyst | `{ contributors, roles }` (`roles` = suggested role names; any text ≤40 is accepted) |
| POST | `/api/studio/series/:id/contributors` | editor | `{ name, role, username?, release_id?, position? }` — `username` links the credit to an account (400 if unknown) → 201 `{ contributor }` |
| PATCH | `/api/studio/series/:id/contributors/:contributorId` | editor | partial; `username: null` unlinks → `{ contributor }` |
| DELETE | `/api/studio/series/:id/contributors/:contributorId` | editor | |

### Forum moderators

Forum on/off and its description are the series fields `forum_enabled` / `forum_description`.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/series/:id/moderators` | analyst | `{ forum_enabled, forum_description, moderators: [{ source: "owner"|"moderator", user_id, username, display_name, avatar_url, created_at }] }` — brand owners are listed first and cannot be removed here |
| POST | `/api/studio/series/:id/moderators` | editor | `{ username }` (a leading `@` is fine) → 201 `{ moderators }`; 400 unknown user, 409 already a moderator |
| DELETE | `/api/studio/series/:id/moderators/:userId` | editor | `{ moderators }` |

### Revenue splits

Split: `{ id, share_bps, note, created_at, payee_id, payee_slug, payee_name }`. The payee is another brand.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/series/:id/splits` | admin | `{ splits, total_bps, kept_bps }` |
| POST | `/api/studio/series/:id/splits` | admin | `{ payee_slug, share_bps (1-10000), note? }` → 201 `{ split }`. 400 if the payee is this brand, unknown, or the total would pass 10000; 409 if that payee already has a split |
| PATCH | `/api/studio/series/:id/splits/:splitId` | admin | `{ share_bps?, note? }` → `{ split }` |
| DELETE | `/api/studio/series/:id/splits/:splitId` | admin | |

### Embed widgets ("Read now" button and cover card)

`GET /api/studio/series/:id/widget?color=1a1c20&size=small|medium|large&label=&theme=light|dark` (analyst)

```json
{ "color": "1a1c20", "size": "medium", "theme": "light", "label": "",
  "sizes": { "small": { "width": 140, "height": 40 }, "medium": { "width": 180, "height": 48 }, "large": { "width": 240, "height": 60 } },
  "available": true, "unavailable_reason": null,
  "read_now": { "url": "…/widgets/read-now/:slug?color=&size=&label=", "width": 180, "height": 48, "html": "<iframe …></iframe>" },
  "card":     { "url": "…/widgets/card/:slug?color=&theme=", "width": 360, "height": 180, "html": "<iframe …></iframe>" },
  "series_url": "…/series/:slug" }
```

`label` (max 40 chars) replaces "Read now" on the button. `theme` applies to the card. `available` is false, with a sentence in
`unavailable_reason`, when the public widget would answer "not available": draft, taken down, or an adult series (widgets never
show adult titles). The widget pages themselves are `GET /widgets/read-now/:slug` and `GET /widgets/card/:slug` (`widgets.ts`):
script-free, cookie-free HTML with `frame-ancestors *`, meant for an iframe on any site.

### First time public

`PATCH /api/studio/series/:id` returns `{ series, launch_notified }`. When the patch takes the series out of `draft` for the first
time (`series.launched_at` was null), followers of the series and of the brand get ONE notification and one email summarizing the
releases that were already published; `launch_notified` is how many people were told (`0` if nothing was published yet), otherwise
`null`. Releases published while the series is a draft send nothing; releases published afterwards notify one by one as before.

## 3. Releases — `studio-releases.ts`

### Release object

```
{ id, series_id, number, kind, kind_label, group, language, title, synopsis, mature,
  status: "draft"|"scheduled"|"published", publish_at, published_at,
  price_cents, download_price_cents, download_discount_pct, force_free, free_at, free_pages,
  themes[], audiences[], content_ratings[], isbn, print_url, orig_pub_date,
  page_count, cover_page_id, cover_url, cover_thumb_url, spread_pref: "first"|"last", single_cover,
  url, created_at, updated_at }
```

- `price_cents`: null = series default, 0 = not sold on its own.
- `download_price_cents`: null or 0 = download not for sale. `download_discount_pct` 1-100 or null.
- `free_at`: the release becomes free to read at this time. `force_free`: always free.
- `free_pages`: null = follow the series preview rule.
- `published_at` is the first publication and is kept when a release is unpublished.
- `cover_page_id` null = page 1 is the cover. `cover_url` follows automatically.
- `number` is unique per series + language + kind (each type has its own sequence).
- `isbn` accepts ISBN-10/13 with or without dashes; the check digit is verified and the bare digits are stored.

Editable fields: `title`, `synopsis` (≤1800), `kind`, `language`, `number`
(≤2 decimals), `mature`, `isbn`, `print_url`, `orig_pub_date`, `audiences` (≤3),
`themes` (≤6), `content_ratings`, `price_cents`, `download_price_cents`,
`download_discount_pct`, `force_free`, `free_at`, `free_pages`, `spread_pref`,
`single_cover`.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/series/:id/releases?language=en` | analyst | `{ series: { id, title, slug, language, reading_dir }, releases: [Release + frames_missing, contributor_count, active_job: { id, kind, status, done, total } | null], groups }` ordered by language, type, number. `groups` = release types grouped as in the create dialog. Without `language`, every edition. |
| POST | `/api/studio/series/:id/releases` | editor | All fields optional. Defaults: `kind` `issue` (`episode` for vertical series), `language` = series language, `number` = next in that kind+language, `title` = "Issue 3". 201 `{ release }`. 409 if you pass a `number` already in use. |
| GET | `/api/studio/releases/:id` | analyst | `{ release: Release + frames_missing, series: { id, slug, title, language, reading_dir, layout, access_model, has_cover }, brand: { id, slug, name }, contributors }` |
| PATCH | `/api/studio/releases/:id` | editor | partial → `{ release }` |
| PUT | `/api/studio/series/:id/releases/bulk` | editor | The metadata / pricing table. `{ releases: [{ id, ...fields }] }`. All rows are saved or none; numbers may be swapped between rows in one save. `{ releases }` (the rows that changed) |
| PUT | `/api/studio/series/:id/releases/order` | editor | `{ kind, language?, ids: [...] }` — `ids` must be every release of that type and language exactly once; they are renumbered 1..n. `{ ok, order: [{ id, number }] }` |
| POST | `/api/studio/releases/:id/publish` | editor | Needs a confirmed email (403 `email_unverified`). Body `{}` = publish now; `{ publish_at }` in the future = schedule (status `scheduled`; a job publishes it within ~30 s of the time). Needs ≥1 page. `{ release, first_publish }` |
| POST | `/api/studio/releases/:id/unpublish` | editor | Back to `draft`; also cancels a schedule. `{ release }` |
| GET | `/api/studio/releases/:id/preview-link` | editor | `{ url }` = `{APP_URL}/read/:id?preview=<private_token>` |
| POST | `/api/studio/releases/:id/preview-link/rotate` | editor | New token; old links stop working. `{ url }` |
| DELETE | `/api/studio/releases/:id` | editor (admin once it has been published) | soft delete; its number becomes free again |

On the **first** publish: followers are notified (`notifyNewRelease`: bell + `new_release`
email) unless the series is still `draft`, and a series without a cover gets page 1 as its cover.
A scheduled release that has no pages when its time comes goes back to `draft`.

---

## 4. Upload and ingestion — `studio-pages.ts`

### Upload

`POST /api/studio/releases/:id/upload` (editor) — `multipart/form-data`, any
number of files (max 400 per request, 600 MB each), any field names, any mix of:

- PNG / JPG / WebP images → appended in natural filename order (`p2` before `p10`)
- ZIP / CBZ → the images inside, in natural path order (`__MACOSX`, dotfiles and non-images ignored)
- PDF → every page rendered at 200 DPI (long edge capped at 3000 px)

Files are recognized by content, not extension. If any file is not an image,
ZIP or PDF the whole request is rejected with 400 and nothing is stored.

Response 202:

```
{ jobs: [{ id, kind: "ingest", status: "queued", done, total, error, created_at, finished_at }],
  archives: [{ id, filename, bytes, created_at }] }
```

One job for all loose images, one per archive. Jobs of a release run one after
another in upload order. New pages are appended after the existing ones.

For each page ingestion stores the original
(`private/originals/<release>/<page>.<ext>`; PDF pages as PNG) and WebP variants
`thumb` (320 w), `medium` (1100 w), `full` (2200 w) under
`private/pages/<release>/<page>/`, and fills `width`, `height`, `bytes`,
`filename`, `dpi`, `bg_color` (dominant edge color). The release cover is
refreshed when the job ends.

### Progress

`GET /api/studio/releases/:id/jobs` (analyst) — poll about once a second while `processing`.

```
{ processing: bool,          // any job queued or running
  done, total,               // summed over the active jobs: "19 / 32 pages processed"
  page_count,                // pages in the release right now
  jobs: [{ id, kind: "ingest"|"detect_frames", status: "queued"|"running"|"done"|"failed",
           done, total, error, source: "images"|"archive"|null, filename,
           skipped: [names of archive entries that could not be read],
           pages_added, detected, kept_manual, created_at, finished_at }] }   // newest first, last 30
```

`total` is 0 for an archive until it has been opened. A `failed` job has a
readable `error` ("No PNG, JPG or WebP images were found in …", "This PDF is
password-protected …"). Jobs survive a server restart: a job whose worker
stopped is resumed after about 45 seconds and never duplicates pages.

### Archives

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/releases/:id/archives` | analyst | `{ archives: [{ id, filename, bytes, created_at, page_count, extracting, download_url }] }` |
| POST | `/api/studio/archives/:id/extract` | editor | Extract again: pages that came from this archive are **replaced** (appended at the end; frames on the old ones are lost). 202 `{ job }`; 409 if already extracting |
| GET | `/api/studio/archives/:id/download` | editor | the uploaded file |
| DELETE | `/api/studio/archives/:id` | editor | removes the stored archive; its pages stay |
| GET | `/api/studio/releases/:id/originals.zip` | editor | streams every original page as `page-001.png …` |

---

## 5. Pages — `studio-pages.ts`

Positions are 1-based and always dense (1..n).

### Page grid

`GET /api/studio/releases/:id/pages` (analyst)

```
{ release: { id, title, page_count, spread_pref, single_cover, cover_page_id },
  access: { model, release_free, free_pages, locked_pages },   // what a visitor with no account gets
  frames_missing,
  pages: [{ id, position, width, height, bytes, filename, bg_color, thumb_url,
            frames_count, frames_status: "missing"|"auto"|"manual",
            is_free: true|false|null,     // the override: always free / always locked / follow the rule
            free: bool,                   // the outcome for a visitor (uses the real paywall rules)
            is_cover: bool,
            spread: number|null,          // pair number (badge "D-3"); null when not paired
            side: "single"|"left"|"right"|"wide" }] }
```

Spread pairing: a page wider than tall is `wide` (already a spread). With
`single_cover` page 1 stands alone. Each run of upright pages is paired two by
two; with an odd run, `spread_pref: "last"` leaves the first page of the run
single, `"first"` leaves the last one. In `rtl` series the first page of a
pair is `right`. Vertical-scroll series never pair.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/pages/:id` | analyst | `{ page: { id, release_id, position, filename, bytes, width, height, dpi, bg_color, is_free, created_at, status: "processed", frames, frames_status, texts, urls: { original, full, medium, thumb }, is_release_cover }, release: { id, title, number, kind, language, page_count, status }, series: { id, title, slug, reading_dir, layout, language }, prev_id, next_id, first_id, last_id }` |
| GET | `/api/studio/pages/:id/image/:variant` | analyst | `variant` = `original` `thumb` `medium` `full`. Streams the image (`cache-control: private`). `?download=1` adds an attachment header. |
| PATCH | `/api/studio/pages/:id` | editor | `{ is_free?: true|false|null, bg_color?: "#rrggbb" }` → `{ page: { id, is_free, bg_color } }` |
| DELETE | `/api/studio/pages/:id` | editor | `{ ok, deleted: 1 }` |
| POST | `/api/studio/releases/:id/pages/delete` | editor | `{ ids: [...] }` → `{ ok, deleted }` |
| POST | `/api/studio/releases/:id/pages/free` | editor | `{ ids: [...], is_free: true|false|null }` → `{ ok, updated }` |
| PUT | `/api/studio/releases/:id/pages/order` | editor | `{ ids: [...] }` — every page of the release exactly once → `{ ok, order: [{ id, position }] }` |
| POST | `/api/studio/pages/:id/series-cover` | editor | Use this page as the series cover → `{ cover_url, cover_thumb_url }` |
| POST | `/api/studio/pages/:id/release-cover` | editor | → `{ cover_page_id, cover_url, cover_thumb_url }` |
| DELETE | `/api/studio/releases/:id/cover` | editor | Back to "page 1 is the cover" → same shape, `cover_page_id: null` |

Covers are written to `public/covers/...-lg.webp` (800 w) and `-sm.webp` (320 w).

---

## 6. Frames and text regions — `studio-pages.ts`, `lib/panels.ts`

A frame is a fraction-of-page shape (0..1, origin top-left):

```
{ "x": 0.05, "y": 0.04, "w": 0.44, "h": 0.45 }            // rectangle
{ "points": [[0.05,0.05],[0.95,0.05],[0.95,0.4],[0.05,0.6]] }  // polygon, 3-400 points
```

`pages.frames` is the ordered list (reading order). `frames_status`:
`missing` (none yet), `auto` (detected), `manual` (saved from the editor).

| Method | Path | Who | Notes |
|---|---|---|---|
| PUT | `/api/studio/pages/:id/frames` | editor | `{ frames: [...], auto_order?: bool }` — saves and marks `manual` (`missing` if the list is empty). `auto_order` re-sorts into reading order for the series direction. `{ frames, frames_status }` |
| POST | `/api/studio/pages/:id/frames/detect` | editor | Body `{}` detects, saves (replacing what was there) and marks `auto`; `{ save: false }` only returns a suggestion. `{ frames, saved, frames_status }` |
| POST | `/api/studio/releases/:id/frames/detect` | editor | Whole release as a job. `{ force?: bool }` — pages with `manual` frames are kept unless `force`. 202 `{ job }` (kind `detect_frames`; progress via the jobs endpoint, which reports `detected` and `kept_manual`). 409 if one is already running. |
| POST | `/api/studio/pages/:id/frames/smart` | editor | `{ x, y }` → `{ frame }`: the panel under that point, snapped to its gutters (a rectangle, or a polygon for slanted / irregular panels). 400 if the point is in a gutter. Nothing is saved. |
| POST | `/api/studio/pages/:id/frames/refine` | editor | `{ frame, x, y, mode: "add"|"remove" }` → `{ frame }`. `add`: the panel under the point is merged into the frame (the gutter between is bridged). `remove`: the panel under the point is cut out of the frame; if the frame is one panel, the patch of similar tone under the point is cut. 400 with a hint when there is nothing to add/remove. Nothing is saved. |
| PUT | `/api/studio/pages/:id/texts` | editor | `{ texts: [{ x, y, w, h, text: { "en": "…", "fr": "…" } }] }` (≤300 regions, keys are language codes) → `{ texts }` |

Detection is classical image processing on an 800 px grayscale copy: gutter
color from the page border, threshold, recursive XY-cut on empty rows /
columns, connected regions for layouts no straight cut can split, full-bleed
pages become one whole-page frame, then reading order (rows, then columns in
the series' reading direction). No generative AI; nothing leaves the server.

---

## 7. Promo codes — `studio-commerce.ts`

### Code object

```
{ id, code, kind: "unlock"|"discount", scope: "release"|"series"|"brand", series_id, release_id, scope_title,
  percent_off, includes_download, max_redemptions, redeemed_count,
  batch_label, batch_id, assigned_email, sent_at, starts_at, expires_at, disabled, created_at }
```

What a code does (`spec`, shared by single, bulk and import):

- `kind: "unlock"` + exactly one of `release_id` / `series_id` (must belong to
  the brand); `includes_download` also grants the download.
- `kind: "discount"` + `percent_off` (1-100); `series_id` / `release_id`
  optional (neither = anything the brand sells).
- `starts_at`, `expires_at` optional.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/brands/:id/codes?batch_id=&q=&single=1&page=&limit=` | editor | `{ codes, total, page, limit }` (limit default 50, max 500). `q` searches code, email and batch label. `single=1` = only codes outside batches. |
| POST | `/api/studio/brands/:id/codes` | admin | spec + `code?` (5-40 `[A-Z0-9-]`, random `ABCD-EFGH-JKLM` if omitted), `max_redemptions?` (null = unlimited), `assigned_email?` → 201 `{ code }`; 409 if the code text is taken |
| PATCH | `/api/studio/brands/:id/codes/:codeId` | admin | `{ disabled?, max_redemptions?, assigned_email?, starts_at?, expires_at? }` → `{ code }` |
| DELETE | `/api/studio/brands/:id/codes/:codeId` | admin | 409 once redeemed (disable it instead) |

### Batches (backer / reward-tier codes)

Batch: `{ batch_id, batch_label, kind, series_id, release_id, scope_title, includes_download, percent_off, expires_at, total, redeemed, assigned, sent, disabled_count, disabled, created_at }`.
Every code in a batch is single-use (`max_redemptions: 1`).

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/brands/:id/code-batches` | editor | `{ batches }` newest first |
| POST | `/api/studio/brands/:id/codes/bulk` | admin | spec + `{ count (1-5000), batch_label }` → 201 `{ batch_id, created, batch }` |
| POST | `/api/studio/brands/:id/codes/import` | admin | Backer emails, one code each. Body: `csv` (CSV text: a column headed "email", or one address per line; `,` `;` or tab separated) **or** `emails: [...]`; plus either `batch_label` + spec (new batch) or `batch_id` (add to an existing batch: its unassigned codes are handed out first, more are generated if needed). Emails already in the batch are skipped. 201 `{ batch_id, assigned, created, already_in_batch, invalid_rows, batch }`. Max 5000 addresses and ~1.9 MB per call. |
| GET | `/api/studio/brands/:id/code-batches/:batchId/export.csv` | editor | CSV: `code,email,redeemed,redeemed_at,emailed_at,disabled` |
| PATCH | `/api/studio/brands/:id/code-batches/:batchId` | admin | `{ disabled?, batch_label? }` — disables / enables every code of the batch → `{ batch }` |
| POST | `/api/studio/brands/:id/code-batches/:batchId/email` | admin | `{ message (≤1500), title?, resend? }` — sends the `backer_code` email to every assigned, unredeemed, enabled code not emailed yet (`resend: true` = also those already emailed) and stamps `sent_at`. `title` defaults to the release / series title. The link in the mail is `{APP_URL}/redeem?code=…`. `{ ok, sent, not_sent, batch }`. Limits: 6 calls per hour, 10 000 backer emails per day per brand (429). |

---

## 8. Bundles and discounts — `studio-commerce.ts`

### Bundles

```
{ id, title, description, price_cents, includes_download, active, created_at,
  separate_price_cents,      // what the same releases cost one by one
  items: [{ release_id, title, number, kind, language, status, price_cents, download_price_cents,
            series_id, series_title, deleted, cover_thumb_url }] }
```

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/brands/:id/bundles` | editor | `{ bundles }` |
| POST | `/api/studio/brands/:id/bundles` | admin | `{ title, price_cents, release_ids: [...], description?, includes_download?, active? }` — releases must belong to the brand → 201 `{ bundle }` |
| PATCH | `/api/studio/brands/:id/bundles/:bundleId` | admin | partial; `release_ids` replaces the item list → `{ bundle }` |
| DELETE | `/api/studio/brands/:id/bundles/:bundleId` | admin | `{ ok, deactivated }` — a bundle that has been sold is only deactivated (`deactivated: true`) |

### Discounts (timed sales)

```
{ id, label, percent_off (1-95), series_id | null, series_title, applies_to: "all"|"read"|"download",
  starts_at, ends_at | null, active, state: "running"|"upcoming"|"ended"|"off", created_at }
```

`series_id` null = every series of the brand.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/studio/brands/:id/discounts` | editor | `{ discounts }` |
| POST | `/api/studio/brands/:id/discounts` | admin | `{ label, percent_off, series_id?, applies_to? = "all", starts_at? = now, ends_at?, active? = true }` → 201 `{ discount }` |
| PATCH | `/api/studio/brands/:id/discounts/:discountId` | admin | partial → `{ discount }` |
| DELETE | `/api/studio/brands/:id/discounts/:discountId` | admin | |

---

## 9. Analytics — `studio-analytics.ts`

All analyst and up. Every report takes the same query:

- `range=7d|30d|90d|365d` (default `30d`, ending today), **or** `from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive, ≤3 years)
- `format=csv` to download the same rows as CSV
- `series_id=` to narrow to one series (page-reads, countries, followers, engagement, revenue)

Days are UTC. Reports return
`{ range: { from, to, days, previous: { from, to } }, columns: [...], rows: [...] }` plus the extras listed.

### Dashboard

`GET /api/studio/brands/:id/analytics/dashboard`

```
{ range, currency,
  readers:    { unique_readers, visits, page_reads },
  revenue:    { tips, membership, sales, adjustments, total },      // cents, from the ledger; sales = read-online + downloads
  engagement: { followers, favorites, forum_posts, comments,       // new in the range
                followers_total, favorites_total },                // plain numbers: standing today
  emails:     { sent, opened, clicked } }
```

Each metric is `{ value, previous, change, change_pct }` where `previous` is
the same-length period just before, and `change_pct` is null when `previous`
is 0. Page reads = signed-in reads (`page_reads`) + guest reads (`anon_reads`);
a visit = one reader, one release, one day. CSV: `metric,value,previous,change,change_pct`.

### Reports

| Path (under `/api/studio/brands/:id/analytics`) | Rows |
|---|---|
| `/page-reads?group=day` (default) | `day, page_reads, member_page_reads, guest_page_reads, readers` — one row per day, zero-filled |
| `/page-reads?group=series` | `series_id, title, slug, page_reads, readers` |
| `/page-reads?group=release` | `release_id, series_title, title, kind, number, language, status, page_count, page_reads, readers, visits` |
| `/releases/:releaseId/dropoff` | per page: `position, page_id, readers, member_readers, member_reads_of_page, pct_of_start, left_here` — `readers` = readers who got at least that far (guests counted by pages read from the start). Extras: `release: { id, title, number, kind, page_count, series_title }, started, finished` |
| `/countries` | `country, readers, page_reads, share_pct` (signed-in readers only; `unknown` when not located) |
| `/followers` | per day: `day, new_followers, series_followers, brand_followers, total` (`total` = running total) |
| `/engagement` | per day: `day, favorites, comments, forum_posts` |
| `/emails` | per day: `day, sent, opened, clicked`. Extra: `by_template: [{ template, sent, opened, clicked }]` |
| `/revenue` | per month: `month (YYYY-MM), tips_cents, membership_cents, sales_cents, refunds_cents, adjustments_cents, total_cents, gross_cents`. Extras: `currency`, `by_series: [{ series_id, series_title, total_cents }]`, `membership_breakdown: [{ reading_month, series_id, series_title, gross_cents, amount_cents, note, member_page_reads, member_readers }]` — how each membership figure was made up |

---

## 10. Earnings and payouts — `studio-commerce.ts`

All admin and up.

### `GET /api/studio/brands/:id/earnings`

```
{ currency,
  balance_cents,        // everything earned minus everything paid out
  pending_cents,        // earned but inside the hold period
  available_cents,      // balance - pending
  reserved_cents,       // payout requests not yet debited from the ledger
  requestable_cents,    // available - reserved
  next_release_at,      // when the next pending amount becomes available, or null
  totals_by_kind: [{ kind, amount_cents, gross_cents, entries }],   // sale | subscription | tip | payout | refund | adjustment
  payout_minimum_cents, payout_hold_days, payout_configured,
  can_request,          // false while tax_form_required is true
  tax_form_required,    // earnings reached the tax reporting limit and no usable tax form is on file (section 10a)
  share: { sale_bps, subscription_bps, tip_bps } }
```

### `GET /api/studio/brands/:id/ledger?kind=&page=&limit=&format=csv`

```
{ entries: [{ id, created_at, kind, amount_cents, gross_cents,
              balance_cents,                 // running balance after this entry (over the whole ledger)
              available_at, pending, month, note,
              series_id, series_title, release_id, release_title, order_id, payout_id }],
  total, page, limit }      // newest first; limit default 50, max 200
```

### Payouts

Payout: `{ id, amount_cents, status: "requested"|"approved"|"paid"|"rejected", method, note, reference, created_at, reviewed_at, paid_at, requested_by }`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/studio/brands/:id/payouts` | `{ payouts }` newest first |
| POST | `/api/studio/brands/:id/payouts` | `{ amount_cents?, note? }` — amount defaults to everything requestable. 400 if payout details are missing, the amount is under `payout_minimum_cents`, or over `requestable_cents`. **409 with `code: "tax_form_required"`** when the brand has reached the tax reporting limit and has no submitted tax form (section 10a). 201 `{ payout, balance_cents, pending_cents, available_cents, reserved_cents, requestable_cents }` |
| DELETE | `/api/studio/brands/:id/payouts/:payoutId` | Withdraw a request still `requested`; 409 otherwise |

A request only inserts the `payouts` row (method and destination copied from
the payout details). The ledger debit is written when a platform admin
approves it; until a ledger row with that `payout_id` exists the amount shows
as `reserved`, so it is never counted twice.

---

## 10a. Tax information — `studio-tax.ts`, `lib/tax.ts`

Brand admin and up (a platform admin passes as an owner, as everywhere in the
Studio). Editors and analysts get 403.

A brand whose **earnings in a calendar year** reach
`settings.revenue.tax_reporting_threshold_cents` is asked for a tax information
form; while `settings.revenue.tax_form_required` is on, payout requests are
refused until one is on file. The check covers this calendar year and the one
before it.

Earnings in a year = the sum of `amount_cents` over the brand's ledger rows
with `kind in ('sale','tip','subscription','refund')` whose `created_at` is in
that calendar year (America/Indiana/Indianapolis time). Refund rows are
negative, so the figure is net of refunds. `payout` and `adjustment` rows are
not counted.

### `GET /api/studio/brands/:id/tax`

```
{ currency,
  status: { required,               // the admin setting
            limit_cents, year, earnings_cents, previous_year, previous_earnings_cents,
            limit_reached, reached_year,          // this year first, else last year, else null
            form_status: "on_file"|"missing"|"needs_update",
            form_needed,                          // limit reached and form_status is not "on_file"
            payout_blocked },                     // required && form_needed
  profile: null | {
    status: "submitted"|"needs_update", is_us_person, legal_name, business_name,
    classification,             // individual | single_member_llc | c_corp | s_corp | partnership | trust_estate | llc | other
    llc_tax_class,              // c_corp | s_corp | partnership (classification "llc" only)
    other_description,          // classification "other" only
    address_street, address_city, address_state, address_postal, address_country,
    tin_type: "ssn"|"ein"|null, tin_last4,        // never the full ID
    tax_residence_country, foreign_tin_last4, date_of_birth,
    signature_name, signed_at, certification_text,
    needs_update_note,          // the admin's note while status is "needs_update"
    updated_at },
  prefill: { legal_name, legal_name_source: "payout_details"|"owner_name"|null, business_name, address_country },
  certifications: { us, non_us },   // the statement to show and send back unchanged
  classifications, llc_tax_classes,
  notified_at }                     // when the "limit reached" notice was sent, or null
```

`prefill` is what is already on file (payout details' legal name, else the
owner's display name; the brand name; the brand's country). It never contains a
taxpayer ID.

### `PUT /api/studio/brands/:id/tax`

The whole form every time. Body:

```
{ is_us_person, legal_name, business_name?, classification, llc_tax_class?, other_description?,
  address_street, address_city, address_state?, address_postal?, address_country,   // 2-letter country
  // US person
  tin_type: "ssn"|"ein", tin,                       // the full ID, always re-entered
  // not a US person
  tax_residence_country, foreign_tin?, date_of_birth?, not_us_person: true,
  signature_name, certify: true, certification_text }   // certification_text = certifications.us / .non_us as shown
```

Rules: a US address needs a state code and a 5-digit ZIP; `tin` is 9 digits
(dashes and spaces allowed) and obvious junk is refused (all one digit,
123456789, SSN area 000/666, group 00, serial 0000, EIN prefix 00); a non-US
payee needs a residence country other than US and `not_us_person: true`, and
no US taxpayer ID is kept for it; `date_of_birth` is kept for individuals only.
400 `code: "validation"` with a sentence that never repeats the number; 409 if
`certification_text` is not the current wording. Response
`{ profile, status }` (same shapes as GET).

The ID is stored encrypted (`lib/crypto.ts`, AES-256-GCM keyed from
`APP_SECRET`) with the last four digits beside it; the signature is stored with
the time, the IP address and the exact statement. Submitting replaces the
brand's one row, sets `status` back to `submitted` and clears any
"needs update" note. Audit: `tax.profile_submit` / `tax.profile_update`
(classification and ID type only).

### Brand objects

`GET /api/studio/brands` and `GET /api/studio/brands/by-slug/:slug` carry
`tax_form_needed` (= `status.payout_blocked`), set only for brand admins and
owners, for the Studio banners.

---

## 11. Marketing: follower announcements — `studio-marketing.ts`

All admin / owner. An announcement is one email to everyone who follows the brand or any of its series (series follows with
"notify" on), one per person, leaving out accounts that turned off "New releases" emails (`prefs.notify.releases = false`),
unsubscribed, are banned or deleted. It is the `announcement` email template (admin overrides apply), queued in `emails` with
`category = 'marketing'`, `publisher_id` set (so `/analytics/emails` counts it) and `announcement_id` pointing at the row.
Limit: **3 per brand in any 7 days**.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/studio/brands/:id/announcements` | | `{ audience: { followers, emailable }, limit: { per_week, used, remaining, next_available_at }, announcements: [...], series: [{ id, title }], limits: { subject_max, body_max } }` |
| POST | `/api/studio/brands/:id/announcements/preview` | draft | `{ subject, html, audience }`. Nothing is sent. `html` is the complete email. |
| POST | `/api/studio/brands/:id/announcements/test` | draft | Sends it to the caller only, subject prefixed `[Test]`. Not counted in the limit or in analytics. Max 10 an hour. `{ ok, to, email_id }` |
| POST | `/api/studio/brands/:id/announcements` | draft | Sends. 201 `{ announcement, queued, limit }`. 429 code `announcement_limit` over the limit; 400 when nobody can be emailed. |

Draft: `{ subject (3-120 chars, one line), body (10-5000 chars, plain text; blank line = new paragraph), series_id? }`. `series_id`
(one of the brand's non-draft series) adds an "Open <title>" button.

Announcement row: `{ id, subject, body, recipients, created_at, sent_by, series_id, series_title, queued, sent, opened, clicked, failed }`.
`sent` / `opened` / `clicked` are counted from the `emails` rows (opens and clicks arrive through the provider webhooks);
`queued` is still in the queue; `failed` covers failed, suppressed and canceled.

## 12. Takedowns (what the Studio and reader do)

`series.takedown_at` hides a series from the store, search, the brand page and direct links. A reader who holds an entitlement
for a release (purchase, code or grant) can still open that release in the reader and download it if their copy included the
file; the reader manifest then has `series.taken_down: true`, offers no prices, and `prev/next_release_id` only point at releases
the reader owns. `series.takedown_purge = true` (set by platform admins, for content that must go) ends access for everyone except
platform admins, including the brand: the reader answers 404 "This title has been removed" and the Studio stops serving page
images, originals and archives. The rule is `canView` in `lib/access.ts`. The series object's `takedown` is
`{ at, reason, purge } | null`.

## Background jobs

- `jobs/ingest.ts` (every 5 s): runs queued `jobs` rows of kind `ingest` and
  `detect_frames`, and resumes running ones whose heartbeat is older than 45 s.
  Uploads also start their job immediately in the API process.
- `jobs/publish-scheduled.ts` (every 30 s): publishes `scheduled` releases whose `publish_at` has passed.

- **tax-notices** (every 10 minutes): brands that reached the tax reporting
  limit this calendar year or last and have no tax form on file. Owners get one
  in-app notification (`kind: "tax"`) and the `tax_form_needed` email, once per
  brand per year (`tax_notices`). Does nothing while `tax_form_required` is off.

## Schema added (`085_tax_profiles.sql`)

- `tax_profiles`: one row per brand (see section 10a).
- `tax_notices (publisher_id, year)`: the "limit reached" notice was sent.

## Schema added (`010_studio.sql`)

- `pages.ingest_key` (unique), `pages.archive_id`
- `jobs.heartbeat_at`, `jobs.attempts`
- `releases.cover_key` — public cover of the release (large; small = same key ending `-sm.webp`)
- unique index on `releases (series_id, language, kind, number) where deleted_at is null`

## Demo data

`npm run seed -w api -- [you@example.com] [--force]` creates brand "Demo Comics" and four series whose pages are drawn by the
script and run through the real ingestion and frame detection: "Paper Robots" (paged, left to right, premium; CBZ and PDF),
"Moonlit Courier" (manga, right to left, with a landscape double-page spread; ZIP and loose images), "Long Way Down" (webcomic,
vertical scroll) and "After Hours (adult sample, Not safe for work)" (marked mature, for the 18+ gate; nothing explicit in it).
With no email it creates `demo@nsfwcomix.test` with a confirmed email and prints a random password once.

## Schema added (`060_studio_fixes.sql`)

- `series.takedown_purge boolean not null default false`, `series.launched_at timestamptz` (backfilled for non-draft series).
- `brand_announcements (id, publisher_id, series_id, subject, body, recipients, sent_by, created_at)`; `emails.announcement_id`.

## Storage (`lib/storage.ts`)

`storage().putStream(key, pathOrReadable, contentType)` stores from a file path or stream and returns the byte count: local disk
writes to a temp file and renames; R2 sends one PutObject up to 16 MB and a multipart upload (16 MB parts, aborted on failure)
above that. Ingestion uses it for archives, staged images and originals. `put(key, Buffer, type)` is unchanged. Extracting an
archive again now puts the fresh pages where the old ones were in the reading order.
