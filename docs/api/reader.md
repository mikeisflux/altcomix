# Reader + commerce API

Everything a reader touches: store, reader, library, community, account,
checkout, membership, codes, embeddable widgets. Source:
`api/src/routes/{catalog,reader,library,social,account,commerce,widgets}.ts`,
`api/src/lib/{pricing,ledger,payments}.ts`, `api/src/jobs/{settlement,memberships,weekly-digests}.ts`.

## Conventions

- JSON in, JSON out. Errors are `{ "error": "sentence for the reader", "code"?: "machine_code" }`.
- **Auth** column: `public` (works signed out), `user` (401 `Sign in to continue` otherwise),
  `mod` (brand member, series forum moderator or platform admin), `signature` (webhook).
- Every mutating `/api` call needs `x-csrf-token` = the `csrf_token` cookie
  (`GET /api/bootstrap` sets it for signed-out visitors). Webhooks are exempt.
- Money is integer cents in the site currency. Ids are UUIDs. Times are ISO strings.
- Lists take `?page=` (1-based) and `?limit=`, and return `{ items, total, page, limit }` unless noted.
- Anywhere a path has `:slug` for a series or brand, the id works too.
- Statuses used below: `401` signed out, `402` payment needed, `403` not allowed
  (`code: "mature"` = 18+ gate, `code: "email_unverified"` = confirm your email first),
  `404` not found / not available here, `409` conflict (already owned, already used), `429` slow down.
- **Confirmed email.** A signed-in reader whose email is not confirmed gets
  `403 { "error": "Confirm your email to <do the thing>. We sent a link to <email>.", "code": "email_unverified" }`
  from: `POST /api/checkout` (every kind: releases, series, bundles, tips, gift cards, credits),
  `POST /api/membership/start`, `POST /api/comments`, `POST /api/forums/threads`,
  `POST /api/forums/threads/:id/posts`, `PATCH /api/forums/posts/:id`, `POST /api/reports`,
  `POST /api/comments/:id/report` and `POST /api/messages`. Reading, following, favoriting,
  `POST /api/checkout/quote` and `POST /api/codes/redeem` stay open. One helper does it
  (`requireConfirmedEmail` in `lib/email.ts`). The web app answers the code with a prompt and a
  "Resend confirmation email" button (`POST /api/auth/resend-verification`, 3 per 15 minutes).
- `GET /api/bootstrap` → `settings.password_min_length` is the minimum password length the
  register, reset and change-password endpoints enforce (security settings, default 10).

### Series card

Used by every list (`items` of series, store rows, library shelves):

```jsonc
{
  "id", "slug", "title", "type", "genre", "status", "language", "mature",
  "cover_url",                       // string | null
  "publisher": { "id", "slug", "name", "kind": "creator"|"publisher", "verified": bool },
  "release_count": 2,
  "latest_release": { "id", "number", "kind", "title", "published_at" } | null,
  "access_model": "free"|"premium",
  "in_membership": bool,             // premium and included in the membership
  "from_price_cents": 149 | null,    // cheapest release, after any sale
  "list_price_cents": 199 | null,    // same, before the sale
  "sale_percent": 25 | null, "sale_label": "Launch week" | null,
  "badge": { "kind": "free"|"sale"|"unlimited"|"price"|"premium", "label": "Free",
             "price_cents"?, "list_price_cents"?, "percent_off"? },
  "follower_count", "favorite_count", "read_count", "updated_at"
}
```

Badge precedence: free → sale → unlimited (in membership) → price → premium.

### What public lists show

Only series that are `visibility = public`, not deleted, not taken down, whose
brand is not suspended, that have at least one published release, that are not
`blocked` for the visitor's country (`req.country`), and — unless the reader
has `prefs.show_mature` — not mature. Unlisted series open by link but are
never listed.

---

## 1. Catalog (`routes/catalog.ts`)

| Method | Path | Auth | |
|---|---|---|---|
| GET | `/api/home` | public | Storefront |
| GET | `/api/series` | public | Browse + search |
| GET | `/api/series/:slug` | public | Series page |
| GET | `/api/brands` | public | Creators directory |
| GET | `/api/brands/:slug` | public | Brand profile |

News, CMS pages and announcements are served by `routes/content.ts` (not this area).

### GET /api/home

```jsonc
{
  "hero": [ { "id", "headline", "blurb", "image_url", "url", "series": Card | null } ],
  "staff_picks": [ Card & { "blurb" } ],
  "spotlight":   [ Card & { "blurb" } ],
  "new_releases": {
    "last_week": [ { "release": { "id", "number", "kind", "title", "published_at", "cover_url" }, "series": Card } ],
    "earlier":   [ /* same, 7–90 days old */ ]
  },
  "sale": [ { "id", "label", "percent_off", "ends_at", "applies_to": "all"|"read"|"download",
              "publisher": { "slug", "name" }, "items": [Card] } ],
  "independent": [ { "id": "independent:new"|"independent:popular", "title", "items": [Card] } ],
  "continue_reading": [ Continue ],          // [] when signed out; shape under Library
  "favorite_genre": { "id", "label" } | null,
  "for_you": [ { "id": "genre:Sci-Fi", "title": "Sci-Fi", "items": [Card] } ],
  "popular": [Card]
}
```

`for_you` follows `prefs.favorite_genre` (one row per genre of the pick; manga
picks get manga rows first, then the genre in every format). With no pick, or
"A little bit of everything", it is the four most-read genres. `independent`
rows only contain brands of kind `creator`. Hero items without a series are
pure banners (`image_url` + `url`).

### GET /api/series

Query: `q` (search), `type`, `genre`, `themes`, `eras`, `audience`, `art_style`,
`tags`, `status`, `language` (each a comma list; array fields match any),
`publisher` (brand slug), `access` = `free` | `premium` | `membership`,
`on_sale=1`, `price_min`, `price_max` (cents, against the cheapest release
after sales; free series count as 0), `sort` = `new` (default) | `popular` |
`updated` | `title` | `relevance` (default when `q` is given), `page`, `limit` (max 60).

Search matches whole words in title/tags/genre/description, then word
prefixes ("drag" finds "Dragon"), then a substring of the title or brand name.

Response: `{ items: [Card], total, page, limit, sort }`.

### GET /api/series/:slug

Query: `language` (optional; restricts releases and picks that edition's title/description).
Brand members and admins also see draft and scheduled releases.

```jsonc
{
  "series": { "id", "slug", "title", "description", "type", "layout", "reading_dir", "language",
              "languages": ["en","fr"], "status", "visibility", "genre", "themes", "audiences",
              "art_styles", "advisories", "eras", "content_ratings", "tags", "mature",
              "cover_url", "banner_url", "access_model", "in_membership", "free_preview",
              "paywall_expires_days", "allow_comments", "update_frequency", "website", "pub_year",
              "forum_enabled", "forum_description", "created_at", "updated_at" },
  "editions": [ { "language", "title", "description", "access_model" } ],
  "brand": { "id", "slug", "name", "kind", "bio", "avatar_url", "verified", "tips_enabled",
             "membership_note", "following": bool },
  "release_groups": [                      // RELEASE_GROUPS order, empty groups omitted
    { "group": "Singles", "releases": [ {
        "id", "number", "kind", "kind_label", "language", "title", "synopsis", "mature", "status",
        "published_at", "page_count", "cover_url", "print_url", "isbn", "free_at",
        "access": {
          "status": "free"|"preview"|"locked"|"owned"|"membership"|"owner"|"blocked",
          "model", "release_free", "unlock": null|"owner"|"purchase"|"code"|"subscription",
          "can_download", "free_pages", "locked_pages",
          "read_price_cents", "read_list_price_cents",          // null when not sold / owned / free (see "Read offer")
          "download_price_cents", "download_list_price_cents",  // null when not sold / already owned
          "in_membership"
        },
        "progress": { "position", "finished" } | null,
        "contributors": [ { "name", "role", "username" } ]
    } ] }
  ],
  "contributors": [ { "id", "name", "role", "username", "avatar_url" } ],   // series level
  "crowdfunding": Crowdfunding | null,
  "print_links": [ { "release_id", "title", "number", "kind", "url", "isbn" } ],
  "discount": { "label", "percent_off", "applies_to", "ends_at" } | null,
  "offers": {
    "series_price_cents", "series_list_price_cents",  // sum of the read prices above; null unless 2+ releases have one
    "series_release_ids": ["<release id>"],           // exactly the releases in that sum
    "series_release_count",
    "bundles": [ { "id", "title", "description", "price_cents", "list_price_cents",
                   "includes_download", "release_ids" } ],
    "is_member": bool
  },
  "viewer": { "signed_in", "is_brand_member", "following", "notify", "favorite",
              "start_release_id", "resume": bool },
  "counts": { "followers", "favorites", "reads", "releases", "comments", "threads" }
}
```

`access.status`: `free` whole release readable; `preview` some free pages then
a paywall; `locked` nothing free; `owned` bought or redeemed; `membership`
readable through the reader's membership; `owner` their own brand's book.

`Crowdfunding` (null when the banner is off or has no link):

```jsonc
{ "service", "url", "goal_cents", "timezone", "starts_at", "ends_at",
  "state": "upcoming"|"live"|"ended", "active": bool,          // active = not ended
  "seconds_until_start": 0, "seconds_remaining": 86400 | null } // null = live with no end date
```

Errors: 404 (draft, deleted, taken down, suspended brand), 403 `code: "mature"`.

### GET /api/brands

Query: `q`, `kind` = `creator` | `publisher`, `sort` = `popular` (default) | `name` | `new`.
Items: `{ id, slug, name, kind, bio, avatar_url, verified, series_count, follower_count }`.
Only brands with at least one public series.

### GET /api/brands/:slug

Query: `q` searches titles within the brand.

```jsonc
{
  "brand": { "id", "slug", "name", "kind", "bio", "avatar_url", "banner_url", "website", "socials",
             "country", "verified", "membership_note", "tips_enabled", "series_count",
             "follower_count", "created_at" },
  "tip_goal": { "goal_cents", "raised_cents", "percent", "tips", "month": "2026-11" } | null,
  "recent_tips": [ { "name", "message", "created_at", "amount_cents": 333 | null } ],
  "series": [Card], "query": "term",
  "members": [ { "username", "name", "avatar_url", "role", "since" } ],
  "conventions": [ { "id", "name", "location", "booth", "url", "starts_on", "ends_on" } ],
  "viewer": { "following", "is_brand_member" }
}
```

`tip_goal` is this calendar month's tips against `monthly_goal_cents` (null
when tips are off or no goal is set). A tip's `amount_cents` is null when the
tipper hid it (per tip, or `prefs.show_donation_amounts = false`). Member
`name` is the username when that person has `show_real_name` off.

---

## 2. Reader (`routes/reader.ts`)

| Method | Path | Auth | |
|---|---|---|---|
| GET | `/api/releases/:id` | public | Reader manifest (`?preview=<private_token>`) |
| GET | `/media/page/:pageId/:variant` | public* | Page image (`thumb` \| `medium` \| `full`) |
| POST | `/api/reads` | public | Record pages read |
| PUT | `/api/progress` | user | Save reading position |
| GET | `/api/releases/:id/download` | user | CBZ of a release the reader may keep |

### GET /api/releases/:id

```jsonc
{
  "release": { "id", "title", "number", "kind", "language", "mature", "page_count", "synopsis",
               "print_url", "published_at", "status", "cover_url" },
  "series": { "id", "slug", "title", "layout": "paged"|"vertical", "reading_dir": "ltr"|"rtl",
              "cover_url", "allow_comments",
              "publisher": { "id", "slug", "name", "avatar_url" },
              "crowdfunding": Crowdfunding | null },
  "spread": { "pref": "first"|"last", "single_cover": bool },
  "pages": [ { "id", "position", "width", "height", "bg_color",
               "frames": [ { "x","y","w","h" } | { "points": [[x,y],...] } ],
               "locked": bool, "via": "free"|"owner"|"purchase"|"code"|"subscription"|"credit"|null,
               "url_thumb", "url_medium", "url_full" } ],
  "access": { "model": "free"|"premium", "release_free", "unlock": null|"owner"|"purchase"|"code"|"subscription",
              "can_download", "free_pages", "locked_pages", "preview": bool },
  "offers": { "read_price_cents", "read_list_price_cents", "download_price_cents",
              "download_list_price_cents", "series_price_cents", "in_membership", "is_member",
              "membership": { "name", "monthly_cents", "annual_cents" },
              "page_credits_available", "page_credit_cents" },
  "prev_release_id", "next_release_id",       // same language, published, by number
  "progress": { "position", "finished" } | null
}
```

- Locked pages keep `width`/`height`/`bg_color` but have `frames: []` and all
  three URLs `null`. `via` says why an unlocked page is readable.
- Image URLs are relative (`/media/page/<pageId>/medium`). When the manifest
  was fetched with `?preview=<token>`, every URL carries the same query.
- The preview token (the release's private share link) shows a draft or
  scheduled release in full, records nothing, and never allows download.
- Offer prices are `null` when that option does not apply (already owned,
  free to read, not for sale). `series_price_cents` needs 2+ unowned releases.
- Errors: 404 unknown / unpublished / blocked in this country, 403 `code: "mature"`.

### GET /media/page/:pageId/:variant

Streams the image after the same access check as the manifest. `200` image,
`402 { error }` locked, `404` unknown page / variant / release not viewable.
Accepts `?preview=<token>`. Uses the session cookie (not under `/api`, so no
CSRF and no JSON envelope on success).

Caching: free pages `public, max-age=3600`; pages unlocked by a purchase,
code, membership or credit `private, max-age=3600`; preview `private, no-store`.
Private storage keys are not reachable any other way (`/media/public/*` only
serves `public/` keys).

### POST /api/reads

Body `{ "release_id": uuid, "page_ids": [uuid, ...] }` (1–500). Send as the
reader turns pages; repeats are harmless.

- Signed in: first read of each page per reader per calendar month is stored
  with how they had access (`via`) and their country. Only readable pages count.
- Signed out: free pages only, counted per release per day under a hash of
  (daily secret, IP, user agent). No IP address is stored. A visitor can never
  add more than the release's page count per day.
- `series.read_count` rises by what was newly recorded (a brand reading its
  own book does not move it).

Response `{ "ok": true, "recorded": n }`.

### PUT /api/progress

Body `{ "release_id", "position": 0-based page index, "finished"?: bool }` → `{ ok: true }`.
`finished` sticks once true.

### GET /api/releases/:id/download

Streams `application/vnd.comicbook+zip` (`<series>-<kind>-<number>.cbz`) built
from the full-size page images with fflate, stored uncompressed, files named
`001.webp`…. Only when `access.can_download` (brand member, download
purchase, bundle with downloads, or an unlock code that includes the
download); otherwise `403`. **CBZ is the only download format**; there is no
PDF export. Limited to 30 downloads per hour per reader.

---

## 3. Library (`routes/library.ts`)

| Method | Path | Auth | |
|---|---|---|---|
| GET | `/api/library` | user | First page of every shelf |
| GET | `/api/library/continue` | user | In-progress releases |
| GET | `/api/library/history` | user | Everything read, finished included |
| GET | `/api/library/owned` | user | Owned releases (paged) |
| GET | `/api/library/downloads` | user | Owned releases with a download (paged) |
| GET | `/api/library/following` | user | Followed series + brands |
| GET | `/api/library/favorites` | user | Favorite series |
| POST / DELETE | `/api/series/:slug/follow` | user | Follow / unfollow a series |
| POST / DELETE | `/api/series/:slug/favorite` | user | Favorite / unfavorite |
| POST / DELETE | `/api/brands/:slug/follow` | user | Follow / unfollow a brand |

Shapes:

```jsonc
Continue = { "release": { "id", "number", "kind", "title", "page_count", "cover_url" },
             "position", "finished", "read_at", "percent", "series": Card }
Owned    = { "release": { "id", "number", "kind", "title", "page_count", "cover_url", "published" },
             "series": { "id", "slug", "title", "cover_url", "publisher": { "slug", "name" } },
             "source": "purchase"|"code"|"grant", "can_download", "download_url": string|null,
             "acquired_at", "order_id" }
Brand    = { "id", "slug", "name", "kind", "avatar_url", "followed_at" }
```

- `GET /api/library` → `{ continue_reading: [Continue], owned: [Owned], downloads: [Owned], following: [Card], favorites: [Card], brands: [Brand], counts: { owned, downloads, following, favorites, brands } }`
- `/continue`, `/history` → `{ items: [Continue] }`
- `/owned`, `/downloads` → `{ items: [Owned], total, page, limit }`
- `/following` → `{ items: [Card], brands: [Brand], page, limit }`; `/favorites` → `{ items: [Card], page, limit }`
- Follow series: optional body `{ "notify": bool }` (default true; POST again to change it) → `{ following: true, notify, follower_count }`; DELETE → `{ following: false, follower_count }`
- Favorite → `{ favorite: bool, favorite_count }`
- Follow brand → `{ following: bool, follower_count }` (the brand's owners/admins get a notification the first time)

Counters only move when a row was really added or removed, so repeating a call is safe.

---

## 4. Community (`routes/social.ts`)

Author object everywhere: `{ "username", "name", "avatar_url" }` or `null` (deleted account).

### Comments

| Method | Path | Auth | |
|---|---|---|---|
| GET | `/api/comments?series=<slug or id>[&release=<id>]` | public | Paged top-level comments with replies |
| POST | `/api/comments` | user | Post / reply |
| DELETE | `/api/comments/:id` | user | Own comment (admins: any) |
| POST | `/api/comments/:id/hide` | mod | `{ "hidden": bool }` (default true) |
| POST | `/api/comments/:id/report` | user | `{ "reason", "detail"? }` |

- GET → `{ items: [Comment & { replies: [Comment] }], total, page, limit, allow_comments, can_moderate }`
  where `Comment = { id, release_id, parent_id, body, hidden, created_at, author, mine, can_delete, can_hide }`.
  Hidden comments are only returned to moderators and their author (`hidden: true`).
- POST body `{ "series_id", "release_id"?, "parent_id"?, "body" (≤2000) }` → `{ comment }`.
  403 when the series has comments turned off. Replies are one level deep (a
  reply to a reply attaches to the same top comment). Notifies the parent's
  author (`reply`) and anyone `@mentioned`.

### Reports

`POST /api/reports` (user, confirmed email): `{ "target_kind": "series"|"release"|"comment"|"publisher"|"user"|"forum_post"|"forum_thread", "target_id", "reason" (2–80), "detail"? (≤2000) }` → `{ ok: true }`.
404 when the target is gone (a deleted post, or a post in a deleted thread). One open report per person per item.
One open report per reader per item. Forum posts are not a report target in the
schema; report the series or the user.

### Forums

| Method | Path | Auth | |
|---|---|---|---|
| GET | `/api/forums` | public | Site boards + series forums that are switched on |
| GET | `/api/forums/threads?board=<id>` or `?series=<slug or id>` | public | Thread list |
| POST | `/api/forums/threads` | user | New thread |
| GET | `/api/forums/threads/:id` | public | Thread + posts (oldest first, paged) |
| POST | `/api/forums/threads/:id/posts` | user | Reply |
| PATCH | `/api/forums/posts/:id` | user | Edit own post `{ body }` |
| DELETE | `/api/forums/posts/:id` | user / mod | Own post, or any as moderator |
| PATCH | `/api/forums/threads/:id` | mod | `{ "pinned"?, "locked"? }` |
| DELETE | `/api/forums/threads/:id` | author / mod | Delete thread |

- `/api/forums` → `{ boards: [ { id, label, threads, last_post_at } ], series: [ { id, slug, title, cover_url, description, threads, last_post_at } ] }`. Boards come from `lib/taxonomy` `FORUM_BOARDS`.
- Thread list → `{ board: { id, label } | null, series: { id, slug, title, description } | null, items: [Thread], total, page, limit, can_moderate }`,
  `Thread = { id, title, board, series_id, pinned, locked, reply_count, last_post_at, created_at, author }`. Pinned first, then latest activity.
- New thread body `{ "board"?: id, "series_id"?: uuid, "title" (3–140), "body" (≤10000) }` → `{ thread }`. A series needs `forum_enabled` (404 otherwise).
- Thread view → `{ thread, series: { id, slug, title } | null, board, posts: [ { id, body, edited_at, created_at, author, mine, can_edit, can_delete } ], total, page, limit, can_moderate, can_reply }`.
- Reply → `{ post }`. Locked threads take replies from moderators only (403).
- Deleting the opening post deletes the thread (`{ ok, thread_deleted }`).
- Moderators: for a series forum, its `forum_moderators`, the brand's members and admins; for site boards, admins only.
- `@username` in a thread or reply notifies that person (`mention`); the thread author is notified of replies (`reply`).

### Direct messages

| Method | Path | Auth | |
|---|---|---|---|
| GET | `/api/messages/conversations` | user | Inbox |
| GET | `/api/messages/conversations/:id` | user | Messages (marks theirs read) |
| POST | `/api/messages` | user | Send `{ "to": username, "body" (≤4000) }` |

- Inbox → `{ items: [ { id, with: Author, last_message: { body, mine }, last_message_at, unread } ], unread }`.
- Conversation → `{ conversation: { id, with: Author | null, can_reply, cannot_reply_reason: string | null }, messages: [ { id, body, mine, read_at, created_at } ], page, limit }`. `page=1` is the newest page; messages inside a page are oldest first.
- Send → `{ conversation_id, message }`. Starts the conversation if needed. 403
  `email_unverified` when the sender's email is not confirmed; 403 when the
  recipient may not be written to (below). The recipient always gets a
  notification, and the `new_message` email unless `prefs.notify.messages` is false.
- **Who may be written to** is one rule (`canMessage` in `routes/social.ts`), used for
  `can_reply` and for sending, so the two never disagree: the other account exists and is
  not banned, and either it accepts direct messages (`prefs.allow_dms`), or it has itself
  written in this conversation (you can always answer someone who wrote to you), or the
  sender is platform staff. When `can_reply` is false, `cannot_reply_reason` says why.

### Notifications

| Method | Path | Auth | |
|---|---|---|---|
| GET | `/api/notifications[?unread=1]` | user | `{ items: [ { id, kind, title, body, url, read_at, created_at } ], unread, total, page, limit }` |
| POST | `/api/notifications/:id/read` | user | `{ ok, unread }` |
| POST | `/api/notifications/read-all` | user | `{ ok, unread: 0 }` |

Kinds written by this area: `purchase`, `refund`, `membership`, `tip`,
`follower`, `reply`, `mention`, `message` (plus `release` from the studio).
`url` is a front-end path: `/read/<id>`, `/series/<slug>#comment-<id>`,
`/forums/thread/<id>#post-<id>`, `/messages/<conversationId>`, `/u/<username>`,
`/account/purchases`, `/account/membership`, `/studio/earnings`.

Emails: replies and mentions are emailed unless `prefs.notify.replies` /
`.mentions` is false, through the `notice_reply` / `notice_mention` templates
(vars `title`, `preview`, `url`); messages use the `new_message` template;
membership billing notices use `membership_billing` (vars `subject`, `name`,
`body`, `url`). All are entries in `lib/email.ts` `TEMPLATES`, so /admin can edit them.

### Weekly emails (`jobs/weekly-digests.ts`)

Sent once per ISO week (Monday to Sunday, UTC), about the week before it, the
first time the job runs in the new week. `digest_sends (kind, week, user_id)`
is claimed before the email is queued, so a week is never sent twice. Both are
category `notification` (unsubscribe link in the footer); readers who
unsubscribed, are suppressed, or have not confirmed their email are skipped.

| Template | Toggle | Who | What |
|---|---|---|---|
| `weekly_feed` | `prefs.notify.feed` | readers who follow a series or brand, when something came out | releases published last week by followed series / brands (mature ones only if the reader shows mature titles) |
| `weekly_analytics` | `prefs.notify.analytics` | owners and admins of a brand, when a brand had any activity in the last two weeks | per brand: readers, page reads and earnings (ledger sales, tips, membership shares, less refunds) for the week against the week before |

### Feedback and community feed

- `POST /api/feedback` (public): `{ "category"?: "general"|"bug"|"idea"|"billing"|"content"|"other", "body" (≤5000), "page_url"?, "email"? }` → `{ ok: true }`. Lands in the /admin inbox.
- `GET /api/community/feed` (public) → `{ following_releases: [ { release, series: Card } ], releases: [ ... ], threads: [ Thread & { series: { slug, title } | null, board } ] }`.
  Signed in, `following_releases` is the last 60 days from followed series and
  brands; `releases` is the site-wide list and is filled only when
  `following_releases` is empty.

The creators directory is `GET /api/brands`.

---

## 5. Account (`routes/account.ts`)

| Method | Path | Auth | |
|---|---|---|---|
| GET | `/api/account` | user | Profile, settings, wallet |
| PATCH | `/api/account/profile` | user | `{ "display_name"?, "bio"? (≤600) }` |
| POST | `/api/account/avatar` | user | multipart, one image file (≤8 MB) → `{ ok, avatar_url }` |
| DELETE | `/api/account/avatar` | user | |
| PATCH | `/api/account/prefs` | user | Settings (partial) |
| POST | `/api/account/email` | user | Start an email change |
| POST | `/api/account/password` | user | Change password |
| GET | `/api/account/sessions` | user | Signed-in devices |
| DELETE | `/api/account/sessions/:id` | user | Sign one out (not the current one) |
| POST | `/api/account/sessions/revoke-others` | user | Sign out everywhere else |
| POST | `/api/account/delete` | user | Delete the account |
| GET | `/api/account/wallet` | user | Store credit, page credits, log |
| GET | `/api/account/orders` | user | Purchases with their lines |
| GET | `/api/account/membership-payments` | user | Membership charges |
| GET | `/api/account/2fa` | user | Two-factor sign-in status |
| POST | `/api/account/2fa/begin` | user | Start (or restart) setup |
| POST | `/api/account/2fa/confirm` | user | `{ "code" }` → turns it on, returns backup codes once |
| POST | `/api/account/2fa/backup-codes` | user | `{ "code" }` → new backup codes |
| POST | `/api/account/2fa/disable` | user | `{ "password", "code" }` |
| GET | `/api/account/gift-cards` | user | Gift cards bought / redeemed |
| GET | `/api/users/:username` | public | Public profile |

- `GET /api/account` → `{ profile: { id, username, email, email_verified, display_name, bio, avatar_url, created_at, totp_enabled }, prefs: Prefs, wallet: { credit_cents, page_credits }, member: bool }`

```jsonc
Prefs = { "show_mature": false, "reading_language": null /* any */, "interface_language": "en",
          "country": null, "favorite_genre": null, "show_real_name": true,
          "show_donation_amounts": true, "allow_dms": true, "beta": false,
          "notify": { "releases", "messages", "replies", "mentions", "followers", "feed",
                      "analytics", "newsletter" } }   // all bool
```

- `PATCH /api/account/prefs`: any subset of `Prefs` keys (`notify` merges key by key),
  plus `confirm_adult`. Turning `show_mature` on requires `confirm_adult: true`
  in the same request, else `400 code: "confirm_adult"`. `country` is a
  two-letter code or null; `favorite_genre` an id from `meta.favoriteGenres`
  or null; languages from `meta.languages`. → `{ ok, prefs }`.
  `notify.newsletter` also sets the marketing opt-in.
- Avatars are stored as a 256×256 WebP under `public/avatars/`.
- `POST /api/account/email` `{ "new_email", "current_password" }` → `{ ok, sent_to }`.
  Sends the `email_change` template to the **new** address with a link to
  `/confirm-email?token=...`; the front end posts that token to
  `POST /api/auth/confirm-email-change`. Nothing changes until then. 403 wrong
  password, 409 address in use.
- `POST /api/account/password` `{ "current_password", "new_password" }` (minimum
  length from security settings, default 10) → `{ ok, sessions_signed_out }`.
  Every other session is ended.
- Sessions → `{ items: [ { id, current, ip, user_agent, created_at, last_seen_at, expires_at } ] }`; `id` is a 16-character handle.
- `POST /api/account/delete` `{ "password" }` → `{ ok }`. Soft delete: email,
  username, name, bio, avatar, settings and the saved payment method token are
  wiped; sessions, follows, favorites and notifications are removed; the
  membership stops renewing. Orders stay (anonymous). 409 when the reader is
  the only owner of a brand.
- Wallet → `{ wallet: { credit_cents, page_credits, updated_at }, page_credit_cents, log: [ { id, kind, credit_cents, page_credits, note, created_at } ], total, page, limit }`.
  Log kinds: `gift_card`, `purchase`, `refund`, `credits_purchase`, `credits_code`, `page_unlock`.
- Orders → `{ items: [ { id, status: "paid"|"refunded", total_cents, credit_cents, charged_cents, refunded_cents, provider, created_at, paid_at, refunded_at, items: [ OrderLine ] } ], total, page, limit }`.
  `refunded_cents` is what has gone back to the card: the whole charge for a refunded order, the sum of partial refunds for a paid one.

```jsonc
OrderLine = { "id", "kind", "description", "price_cents",
              "release_id", "series_id", "publisher_id", "bundle_id",   // as stored; null when not applicable
              "series_slug", "series_title",        // link the line to /series/<slug>; null for tips, gift cards, credits, multi-series bundles
              "publisher_slug", "publisher_name",   // the brand (tips link to /b/<slug>)
              "release_ids": ["<release id>"] }     // every release the line covers (series and bundle lines list them all)
```

- Membership payments → `{ items: [ { id, status: "pending"|"paid"|"failed"|"refunded", amount_cents, plan, provider, period_start, period_end, date, paid_at, refunded_at, retrying, next_attempt_at } ], total, page, limit }`,
  newest first. `date` is when it was paid (else when it was raised). `retrying` = a declined renewal that will be tried again at `next_attempt_at`.
- Two-factor sign-in (any account; the same flow staff have under `/api/admin/security/2fa/*`):
  - `GET /api/account/2fa` → `{ enabled, enrolment_pending, backup_codes_left }`.
  - `begin` → `{ secret, otpauth_url, qr_data_url }` (PNG data URL of the QR code). 409 if already on. Nothing is enforced yet.
  - `confirm { code }` (6 digits from the app) → `{ ok, backup_codes: [10 strings] }`. The codes are returned this once; only SHA-256 hashes are kept in `users.totp_backup_codes`.
  - `backup-codes { code }` → `{ ok, backup_codes }`; the old set stops working.
  - `disable { password, code }` (`code` = app code or an unused backup code) → `{ ok, setup_required }` (`setup_required` only for staff when admin 2FA is mandatory).
  - Once on, `POST /api/auth/login` answers `401 code: "totp_required"` until `totp` (app code or backup code; a backup code is used up) is sent with the password.
- Gift cards → `{ bought: [ { id, code, amount_cents, balance_cents, recipient_email, message, redeemed, redeemed_at, created_at } ], redeemed: [ { id, amount_cents, redeemed_at } ] }`.
- Public profile → `{ user: { id, username, name, bio, avatar_url, joined_at, accepts_messages, is_me }, brands: [ { slug, name, kind, role, avatar_url } ], favorites: [Card] }`.

---

## 6. Checkout, membership, codes (`routes/commerce.ts`)

| Method | Path | Auth | |
|---|---|---|---|
| POST | `/api/checkout/quote` | user | Price a basket: no side effects |
| POST | `/api/checkout` | user (confirmed email) | Price a basket and start paying |
| GET | `/api/orders/:id[?session_id=cs_...]` | user (owner) | Order status / receipt |
| POST | `/api/checkout/confirm` | user | Confirm any hosted session `{ session_id }` |
| GET | `/api/membership[?session_id=cs_...]` | user | Plans + my membership |
| POST | `/api/membership/start` | user (confirmed email) | `{ "plan": "monthly"|"annual", "next"?: "/same-site/path", "surface"?: "embed"|"redirect" }` |
| POST | `/api/membership/cancel` | user | Stop renewing |
| POST | `/api/membership/resume` | user | Undo a cancel |
| POST | `/api/membership/payment-method` | user | Replace the saved card: `{ "surface"?: "embed"|"redirect" }` |
| POST | `/api/codes/redeem` | user | `{ "code" }` |
| POST | `/api/pages/:id/unlock` | user | Spend one page credit |
| POST | `/api/webhooks/divinity` | signature | Processor webhooks |

### POST /api/checkout

```jsonc
{
  "items": [                                   // 1–20
    { "kind": "release",  "id": "<release id>" },            // read online
    { "kind": "download", "id": "<release id>" },            // download (includes reading)
    { "kind": "series",   "id": "<series slug or id>" },     // every published, unowned, priced release
    { "kind": "bundle",   "id": "<bundle id>" },
    { "kind": "tip",      "id": "<brand slug or id, or series slug or id>", "amount_cents": 500, "message"?, "show_amount"? },
    { "kind": "gift_card", "amount_cents": 2500, "recipient_email"?, "message"? },
    { "kind": "credits",  "quantity": 100 }                  // page credits
  ],
  "code"?: "SAVE-20",          // a discount promo code
  "use_credit"?: true,         // spend store credit first
  "return_to"?: "/read/<id>",  // same-site path to land on afterwards; anything else becomes /library
  "surface"?: "embed"          // how the browser will show the card form: "embed" | "redirect" (default "redirect")
}
```

Response when a card payment is needed:

```jsonc
{
  "url": "https://…/checkout/cs_…",   // the processor's hosted card form for this order
  "session_id": "cs_…",               // what the form's messages carry, and what the confirm calls take
  "order_id": "<uuid>",
  "surface": "embed" | "redirect",    // what the session was really created for (see below): act on this, not on what was asked
  "amount_cents": 484,                // what the card will be charged (total − store credit)
  "return_to": "/read/<id>"
}
```

or `{ "completed": true, "order_id", "return_to" }` when nothing more is needed
(sandbox, or fully covered by store credit / a 100% code).

### The two checkout surfaces

The card form is the processor's hosted page. It is never restyled and card
data never touches this site. The browser chooses how it is shown and says so
with `surface` on `POST /api/checkout`, `POST /api/membership/start` and
`POST /api/membership/payment-method` (anything else is a 400; leaving it out
means `redirect`):

- **`embed`**: the page is framed inside our own dialog
  (`web/src/areas/store/SecureCheckout.tsx`). The session is created with
  `disableAutoRedirect: true`, so the processor does not navigate the browser
  away when it finishes; its page posts window messages to ours instead
  (`{ namespace: "divinitycoin-checkout", type: "ready" | "resize" | "complete",
  sessionId, height?, status?, disableAutoRedirect? }`). The web app accepts
  them only from the origin of `url`, from the frame it created, for this
  `session_id`. A `complete` message only means "ask now": the status it
  carries is ignored and the outcome always comes from the confirm endpoints
  below, which the web app also polls (after 30 seconds, then every 10) in
  case the message never arrives.
- **`redirect`**: the whole browser visits `url`; the processor sends it back
  to `/checkout/return?order=<orderId>&next=<return_to>&session_id=cs_...`
  (cancel: `...&cancelled=1`) or, for a membership card,
  `/account/membership?session_id=cs_...`. Used for iPhones, iPads (including
  iPadOS that reports itself as a Mac) and in-app browsers, which cannot type
  into a framed card form (`web/src/areas/store/checkoutSurface.ts`).

The answer's `surface` is `redirect` whatever was asked when the owner has
switched the embedded checkout off (`settings.payments.divinity_embed_checkout`,
exposed to the web app as `settings.payments.embed_checkout` in
`GET /api/bootstrap`). For the frame to load at all, the processor must list
this site's origin in its `CHECKOUT_FRAME_ANCESTORS` setting.

A tip's `id` is the brand's slug or id (what the store's tip dialog sends); a
series slug or id is also accepted and tips the brand that publishes it (a brand
wins if a brand and a series share a slug). Anything else is
`404 No brand or series matches "<id>". …`; a suspended brand is 404 and a brand
with tips off is 400, each saying so.

All prices are worked out on the server (see Pricing). Limits: tip 1.00–1,000.00,
gift card 5.00–500.00, credits 1–5000, and a card payment must be at least 0.50
(`code: "below_minimum"`). Errors: 409 already owned; 400 not for sale / free to
read / same item twice / code problems (`code_invalid`, `code_expired`,
`code_inactive`, `code_used_up`, `code_wrong_kind`, `code_not_applicable`);
503 `payments_not_configured`.

### POST /api/checkout/quote

Same body as `POST /api/checkout` (`return_to` is ignored). Runs the same
pricing function (`priceBasket` in `routes/commerce.ts`) and writes nothing: no
order, no store credit taken, no code used. Use it to show the total before
paying, and call it again whenever the code or the credit choice changes.

```jsonc
{
  "lines": [ { "kind", "description", "release_id", "series_id", "publisher_id", "bundle_id",
               "list_price_cents",       // before any discount
               "sale_discount_cents",    // taken off by the brand's sale / download discount
               "code_discount_cents",    // taken off by the promo code
               "price_cents" } ],        // what this line costs; same order as `items`
  "list_price_cents": 699,
  "discounts": { "sale_cents": 20, "code_cents": 45 },
  "code": { "code": "SAVE-25", "percent_off": 25 } | null,
  "total_cents": 634,                    // list − sale − code
  "credit_available_cents": 150,
  "credit_applied_cents": 150,           // 0 unless use_credit
  "amount_due_cents": 484,               // what the card is charged = total − credit applied
  "problem": null | { "code": "below_minimum", "message" }   // the checkout would refuse this basket as it stands
}
```

Errors are the checkout's own (same statuses and codes): an invalid, expired,
used or inapplicable code is a 400 here, before any payment is started; 409
already owned; 404 gone. It does not require a confirmed email. Limits: 120
quotes per 10 minutes, 40 quotes with a code per hour (kept apart from the
15 real code attempts per hour at checkout).

The embedded checkout (on `complete`, and on its timer) and the
`/checkout/return` page (after a redirect) both call:

### GET /api/orders/:id

The single source of truth for how a payment went. `?session_id=` is optional;
a still-pending Divinity order is confirmed with the processor before
answering, so polling this endpoint is enough. Calling it again and again while
the buyer is still paying is expected: an open session changes nothing, and a
finished one is applied exactly once (150 confirmations per reader per 10
minutes; beyond that the stored state is returned without asking the processor).

```jsonc
{ "order": { "id", "status": "pending"|"paid"|"failed"|"refunded", "total_cents", "credit_cents",
             "charged_cents", "provider", "created_at", "paid_at", "refunded_at",
             "return_to",
             "payment_state": "pending"|"paid"|"failed"|"expired"|"canceled"|"refunded",
                                                     // `failed` = the card was not accepted; `expired` = the session timed out;
                                                     // `canceled` = the checkout was canceled. All three have status "failed".
             "failure": string|null,                 // one sentence for the buyer, never null when the order failed: the bank's
                                                     // decline reason when the processor gave one ("The card does not have enough
                                                     // available funds. …"), else a plain "nothing was charged" line
             "refunded_cents",                       // back on the card so far (whole charge when refunded)
             "partial_refunds": [ { "amount_cents", "reason", "at" } ],
             "items": [ OrderLine ] } }              // OrderLine as under Account → Orders
```

`POST /api/checkout/confirm { session_id }` does the same for any session and
returns `{ kind: "order"|"membership", status, order_id?, message? }`
(`status`: `paid` | `pending` | `failed` | `expired` | `canceled` for an order;
`active` | `updated` | `pending` | `declined` | `failed` | `expired` | `canceled`
for a membership card; `message` is the buyer-readable reason, present on the
unsuccessful ones).

Closing the embedded checkout part-way leaves the order `pending` (reserved
store credit stays reserved); it is settled by the processor's webhook or the
reconciliation job, and fails with its credit returned when the session expires.

### What a paid order grants

One idempotent function (`completeOrder` in `lib/payments.ts`) runs whichever
of the return page, a webhook or the reconciliation job reports the payment first:

| Line | Result |
|---|---|
| `release` | ownership of the release (read) |
| `download` | ownership with download |
| `series` | ownership of each release that was in the offer when the order was made |
| `bundle` | ownership of its releases, with downloads if the bundle includes them |
| `tip` | a tip on the brand page |
| `gift_card` | a new code, emailed (`gift_card` template) to the recipient, or to the buyer if none was given |
| `credits` | page credits in the wallet |

Then: store credit used is logged, the `receipt` email and a `purchase`
notification are sent, the discount code is marked used, and creator ledger
rows are written.

### Pricing (`lib/pricing.ts`)

- Read price: the release's `price_cents`, else the series `default_price_cents`. 0 / null = not sold on its own.
- Download price: the release's `download_price_cents`. 0 / null = not for sale.
- Discounts do not stack. The reader gets the single best percentage among the
  brand's active `discounts` rows that apply (brand-wide or that series;
  `all` / `read` / `download`) and, for downloads, the release's own
  `download_discount_pct`. Rounded to the nearest cent.
- **Read offer** (`readOffer`): a release has a read price for this reader only
  when it is published, not free to read (free series / language edition /
  country rule, forced free, free date passed, paywall expired, or free under
  the series preview rule), not already owned (purchase or code), the reader is
  not on the brand's team, and it has a price. A membership does not remove the
  price: members can still buy a release to keep. A release that is free for
  everyone reports `access.status: "free"` for members too.
- Whole series = the sum of the read offers of every published release, i.e.
  exactly the releases that show `read_price_cents`. The series page, the
  reader manifest, the quote and the checkout all call the same function
  (`seriesPurchase`), for anonymous visitors, signed-in readers, owners of some
  releases, members and brand staff alike. `offers.series_release_ids` lists them.
- Bundle = its price, less a brand-wide discount if one applies.
- A checkout discount code (`promo_codes.kind = 'discount'`) then takes its
  percentage off the lines in its scope (brand, series or release). Never off
  tips, gift cards or credits.

### Earnings (`lib/ledger.ts`)

For each line: `fee share` = the order's processing cost (estimated from
`settings.revenue.fee_pct_bps` + `fee_fixed_cents` on the amount actually
charged to the card) shared over the lines in proportion to price;
`creator = floor((price − fee share) × share bps)` where the bps is the brand's
override or `settings.revenue.{sale,tip}_share_bps`; revenue-split payees of
the series each get `floor(creator × their bps)` as their own ledger row and
the series owner keeps the rest; the platform keeps `price − fee − creator`.
So `price = fee + creator rows + platform` exactly, and it sums to the order
total. Rows become payable after `payout_hold_days`. Tips are not split.
A page credit pays the creators `page_credit_cents × sale share` when it is spent.

### Membership

`GET /api/membership`:

```jsonc
{
  "member": bool,
  "plans": { "name", "monthly_cents", "annual_cents", "trial_days" },
  "provider": "sandbox"|"divinity",
  "subscription": null | {
    "id", "plan", "status": "active"|"past_due"|"canceled"|"expired", "price_cents", "provider",
    "current_period_start", "current_period_end", "cancel_at_period_end", "canceled_at",
    "renews_at": iso | null, "has_payment_method": bool, "from_code": bool,
    "payment_problem": null | { "attempts", "next_attempt_at", "message" }
  },
  // only with ?session_id= (null when the session is not this reader's):
  "confirmation": null | "active"|"updated"|"pending"|"declined"|"failed"|"expired"|"canceled",
  "confirmation_message": null | "The card was declined. …"   // with declined / failed / expired / canceled
}
```

`?session_id=` confirms that card session with the processor first: `active`
(a membership started), `updated` (a new card saved; an overdue payment was
collected from it), `pending` (the reader has not finished, or the payment is
still in flight), `declined` (card saved but the payment was refused),
`failed` / `expired` / `canceled` (no card was saved). It is the membership
counterpart of `GET /api/orders/:id` and just as safe to repeat: a saved card
is taken in once, so asking again never charges again.

- `POST /api/membership/start` → `{ "url", "session_id", "surface", "status": "pending", "next" }`
  (show the hosted card form per `surface`, see "The two checkout surfaces"; after a
  redirect it returns the reader to `/account/membership?session_id=cs_...`,
  and that page calls `GET /api/membership?session_id=...`), or
  `{ "completed": true, "next", ...membership }` in the sandbox. 409 already a member,
  402 the first payment was declined, 403 `email_unverified`.
  `next` is where the reader was heading (e.g. the release they hit the paywall
  on). Only a same-site path is kept (`/…`, not `//…`); anything else comes back
  as `null`. It rides in the hosted flow's return URL
  (`/account/membership?next=<path>&session_id=cs_...`; cancel:
  `/account/membership?cancelled=1&next=<path>`), and `/account/membership`
  sends the reader on to it once the session is confirmed `active`.
- `cancel` → access continues to `current_period_end`, no further charges
  (a `past_due` membership ends at once). `resume` undoes it while the period
  is still running. Both return `{ ok, ...membership }`.
- `payment-method` → `{ "url", "session_id", "surface" }` (hosted card form, shown per
  `surface`; confirm with `GET /api/membership?session_id=`) or `{ completed: true, ... }` in the sandbox.
  A new card on a past-due membership is charged straight away.

How billing works: the hosted checkout runs in SETUP mode and gives NSFWComix an
opaque payment method token (`pm_…`), the only payment credential stored. The
first period is charged with it immediately; `jobs/memberships.ts` charges each
renewal when the period ends. A declined renewal makes the membership
`past_due` (no access) and is retried after 1, 3 and 5 days; the fourth decline
ends it (`expired`). The reader is emailed on the first decline and at the end.
A membership from a code has no payment method and simply expires.

### POST /api/codes/redeem

Body `{ "code" }` (case and spaces ignored). Response always has `kind` and a
`message` to show:

| `kind` | Extra fields | |
|---|---|---|
| `unlock` | `series_slug`, `release_ids`, `includes_download` | A release, or every release of a series that exists today (drafts included) |
| `membership` | `days`, `member_until` | Platform-issued. Extends a code membership; refused (409) while a paid membership is running |
| `credits` | `page_credits_added`, `page_credits` | Platform-issued |
| `gift_card` | `credit_cents`, `wallet_credit_cents` | Adds store credit |

Rules: disabled, not-yet-active and expired codes are refused; `max_redemptions`
is enforced; one use per account (409); a code with `assigned_email` needs the
redeemer's **confirmed** address to match (403); discount codes are for
checkout (`code_wrong_kind`); membership and credit codes owned by a brand are
not honored. Limited to 8 attempts per account and 30 per network per hour (429).

### POST /api/pages/:id/unlock

No body. Spends one page credit on one locked page →
`{ "ok": true, "page_credits": <balance>, "spent": 1 }`. A page that is already
readable costs nothing (`spent: 0`). 402 with no credits.

### Partial refunds

`refund.completed` with `partial: true` and `amount` (cents) for an order
(`partialRefundOrder` in `lib/payments.ts`):

- The order stays `paid` and the reader keeps everything it unlocked.
- The refund is shared between what the creators earned, what the platform kept
  and the processing fee in proportion to how the order's total was shared
  (`refundParts` in `lib/ledger.ts`, largest remainder), so
  `creator + platform + fee = refund` exactly. Running totals are used, so any
  number of partial refunds adds up to the cent.
- Creator part: negative `refund` ledger rows, spread over the order's payees
  (owner and revenue-split payees) in proportion to what each earned; `gross`
  goes down by the refund.
- Recorded on the order: `orders.refunded_cents` (running total) and
  `orders.meta.partial_refunds[]` = `{ ref, amount_cents, creator_cents, platform_cents, fee_cents, reason, at }`.
  The reader gets a `refund` notification.
- Idempotent per `refundId` (without one, the same amount again within ten
  minutes is treated as a redelivery).
- When partial refunds reach the whole card charge the order is reversed as a
  full refund (access removed, store credit returned). A later full refund asks
  the processor only for what is left and reverses only what still stands.
- A partial refund of a membership charge changes nothing automatically; the
  admins are alerted.

### POST /api/webhooks/divinity

For the processor only. Verifies `X-Webhook-Signature: t=<unix>,v1=<hex>` =
HMAC-SHA256 of `"<t>.<raw body>"` with `settings.payments.divinity_webhook_secret`
(5-minute window): 401 on a bad signature, 503 if no secret is configured.
Always answers `200 { success: true, message }` once accepted, including for
events that match nothing, so they are not redelivered.

| Event | Effect |
|---|---|
| `checkout.completed` | Order paid, or membership card saved and first period charged |
| `checkout.failed` / `expired` / `canceled` | Pending order failed and reserved store credit returned (ignored when `pledgeAlreadyPaid`) |
| `payment.succeeded` | Order / membership charge marked paid and captured |
| `payment.failed`, `payment.requires_action` | Orders stay open (the hosted page allows another card); a membership charge is counted as declined if we had no answer for it |
| `refund.completed` | `partial: false` (or absent): order or membership charge reversed in full. `partial: true` with `amount` (cents): see Partial refunds |
| `dispute.created`, `chargeback.created` | Same reversal, admins alerted |
| `test.ping` | Acknowledged |

---

## 7. Payments (`lib/payments.ts`)

Provider comes from `settings.payments.provider`.

**`divinity`** (production; Divinity payments partner API,
`POST <divinity_api_url>?action=…`, `Authorization: Bearer <api key>`,
`X-Partner-ID`). Hosted checkout only: card details are entered on the
processor's page and never reach NSFWComix.

| Our action | Partner call | Notes |
|---|---|---|
| Start an order | `create-checkout-session` `mode: payment` | `pledgeId` = order id, `projectId` = `nsfwcomix-store`, `idempotencyKey` = order id, `returnUrl` as above |
| Start a membership / change card | `create-checkout-session` `mode: setup` | `idempotencyKey` = `setup-<subscription id>` |
| Reader returns / reconciliation | `get-checkout-session` | |
| Charge a period | `charge-saved-payment-method` | `pledgeId` = the charge row id (new for every period), `projectId` = `nsfwcomix-membership`, `idempotencyKey` = `attempt-<n>` |
| Unanswered charge | `lookup-payment` | before any repeat |
| Complete the sale | `capture` `{ pledgeId }` | each payment is a hold on the processor's side; captured as soon as the hold exists |
| Refund | `refund` `{ paymentIntentId, pledgeId, amount, reason }` | |

The reader's IP and user agent are recorded on the order / membership when
they check out and sent as `customerIpAddress` / `customerUserAgent`;
renewals send the values from when the card was saved.

**`sandbox`** (development): orders and memberships complete instantly with no
processor; the job rolls membership periods forward. With
`NODE_ENV=production` it is refused with `503 payments_not_configured` and a
message telling the admin to configure payments.

Functions other areas call:

- `refundOrder(orderId, { reason })` → `{ refunded }` — processor first, then books.
- `reverseOrderBooks(orderId, { reason })` — books only (ledger reversed, ownership removed, store credit returned).
- `refundCharge(chargeId, reason)` → `{ refunded }` — a membership charge.
- `settleMonth('YYYY-MM' | 'YYYY-MM-01', { ranBy })` and `previewSettlement(month)` in `jobs/settlement.ts`.

## 8. Membership settlement (`jobs/settlement.ts`)

Runs hourly for any finished month with unsettled membership money, and on
demand from /admin. Per member-month: `net = gross − fee`, shared among the
series that member read that month in proportion to distinct pages read
through the membership. A member who read nothing puts their net in a pool
shared among all series by everyone's membership reads. Each series' total
then pays `floor(net × membership share bps)` to creators (brand override,
else the platform default; revenue splits as for sales) and the rest to the
platform. Proportional splits use the largest-remainder method (ties to the
lower series id), so `gross = fees + creators + platform` to the cent and the
same inputs always give the same result. A month is settled once: the
`settlements` row, the unique ledger index and `sub_months.settled_at` make a
second run a no-op. If nobody read a membership page all month there is no
creator to pay and that month's pool stays with the platform
(`undistributed_cents` in the result).

`settleMonth` result:

```jsonc
{ "month": "2026-10-01", "already_settled": bool, "subscribers", "gross_cents", "fee_cents",
  "creator_cents", "platform_cents", "pool_cents", "undistributed_cents",
  "series": [ { "series_id", "publisher_id", "pages", "net_cents", "creator_cents", "platform_cents" } ] }
```

An annual payment is booked as twelve equal monthly pots starting with the
month it was paid in.

---

## 9. Widgets (`routes/widgets.ts`)

Self-contained HTML pages (no scripts, no cookies) for creators to embed in an
`<iframe>` on any site. Public, unlisted and non-mature series only; 404 page otherwise.

| Path | Query |
|---|---|
| `GET /widgets/read-now/:slug` | `color` (hex, `ff6600` or `%23ff6600`), `size` = `small` \| `medium` \| `large`, `label` (≤40 chars, default "Read now") |
| `GET /widgets/card/:slug` | `color` (button), `theme` = `light` \| `dark` |

Suggested embed code:

```html
<iframe src="https://SITE/widgets/read-now/SERIES-SLUG?color=1a1c20&size=medium"
        width="160" height="46" style="border:0" title="Read on NSFWComix"></iframe>
<iframe src="https://SITE/widgets/card/SERIES-SLUG" width="360" height="180" style="border:0"
        title="Read on NSFWComix"></iframe>
```

Button heights: small 34px, medium 42px, large 54px. The link opens the series
page (`/series/<slug>`) in a new tab.
