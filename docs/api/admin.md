# Admin / operations API

Source: `api/src/routes/admin-*.ts`, `content.ts`, `cron.ts`, `webhooks-email.ts`,
`health.ts`; helpers in `api/src/lib/admin.ts`.

## Conventions

- **Auth.** Session cookie. Every handler checks the role itself.
  **admin** = role `admin` or `super_admin`; **super** = `super_admin` only.
  Not signed in: `401 {"error"}`. Wrong role: `403 {"error"}`.
- **Super admin only:** settings (read and write), everything under Security
  except your own 2FA, payouts, settlement, per-brand share overrides, manual
  ledger adjustments, wallet adjustments, issuing/voiding gift cards, role
  changes, email queue pause/resume, saving/resetting email templates, cron.
- **CSRF.** Every `POST/PUT/PATCH/DELETE` needs `x-csrf-token` equal to the
  `csrf_token` cookie (webhooks, cron and `/api/track/error` are exempt).
- **Required 2FA.** When `settings.security.admin_2fa_required` is on, an admin
  without TOTP gets `403 {"error": "...", "code": "mfa_setup_required"}` from
  every `/api/admin/*` route except `/api/admin/security/2fa*`. Show the
  enrolment screen when you see that code.
- **Errors** are `{"error": "sentence", "code"?: string}`. Validation errors
  are `400` with `code: "validation"`. An id that is not a UUID is a `404`.
- **Lists** take `?page=1&limit=50` and return `{ items, total, page, limit }`
  (plus extras noted below). Filters are query-string values; unknown values
  are ignored.
- **Dates** are ISO strings. **Money** is integer cents.
- **Audit.** Every mutation writes an `audit_log` row (`action` shown as *audit:*).
- Responses under `/api/admin` carry `cache-control: no-store`.

---

## 1. Dashboard

### GET /api/admin/dashboard — admin
Query: `days` (1–365, default 30).

```json
{
  "days": 30,
  "totals": {
    "users": 0, "brands": 0, "series": 0, "releases": 0, "pages_read": 0, "orders": 0,
    "sales_cents": 0, "membership_cents": 0, "gross_cents": 0, "fee_cents": 0, "refunded_cents": 0,
    "creator_cents": 0, "platform_cents": 0, "active_members": 0, "mrr_cents": 0,
    "pending_payouts": 0, "pending_payouts_cents": 0, "approved_payouts": 0, "approved_payouts_cents": 0,
    "open_reports": 0, "emails_queued": 0, "emails_failed": 0, "unresolved_errors": 0, "blocked_ips": 0
  },
  "series": {
    "days": ["2026-11-01", "..."],
    "users": [0], "brands": [0], "series": [0], "releases": [0], "pages_read": [0], "orders": [0],
    "sales_cents": [0], "membership_cents": [0], "gross_cents": [0], "fee_cents": [0], "refunded_cents": [0],
    "creator_cents": [0], "platform_cents": [0], "new_members": [0]
  }
}
```

Every array in `series` has one value per entry of `series.days` (new per day,
not cumulative). Definitions: `gross` = store orders + membership charges;
`creator_cents` = ledger rows of kind sale / subscription / tip / refund;
`platform_cents = gross - fee - creator - refunded`. Membership money reaches
`creator_cents` when the month is settled, so platform revenue for the current
month is overstated until then. `mrr_cents` counts active, non-cancelling
memberships (annual price / 12).

### GET /api/admin/badges — admin
Sidebar counts: `{ reports, payouts, feedback, errors, emails_failed, emails_queued, kind_requests, blocked_ips }`
(`payouts` = requested, `feedback` = new, `errors` = unresolved, `blocked_ips` = active).

### GET /api/admin/health — admin

```json
{
  "ok": true,
  "db": { "ok": true, "ms": 3, "version": "19.0", "size_bytes": 0, "connections": 12 },
  "storage": { "ok": true, "driver": "local", "ms": 3 },
  "disk": { "path": "/srv/nsfwcomix/storage", "used_bytes": 0, "files": 0, "volume_total_bytes": 0, "volume_free_bytes": 0, "volume_used_pct": 12.3 },
  "email": { "ok": true, "provider": "log", "configured": false, "from_email": "", "queue_paused": false, "webhook_verification": null, "last_sent_at": null },
  "payments": { "ok": true, "provider": "sandbox", "configured": false, "webhook_secret_set": false, "webhook_url": "https://.../api/webhooks/divinity" },
  "jobs": { "in_process": true, "cron_secret_set": true, "last_runs": [{ "job": "", "ok": true, "detail": "", "started_at": "", "finished_at": "" }] },
  "server": { "node": "v26", "uptime_s": 0, "env": "production", "rss_bytes": 0, "pid": 0 },
  "warnings": ["sentence", "..."]
}
```

`storage` is a real write / read-back / delete round trip. `disk.used_bytes`
is the size of the local storage directory (refreshed every 5 minutes).
`db`/`storage`/`disk` carry `error` instead when they fail. In production,
`payments.ok` is false and a warning is listed while no processor is
configured. `jobs.in_process` describes the process that answered.

---

## 2. Users

### GET /api/admin/users — admin
Filters: `q` (email, username, display name, exact id or last IP), `role`
(`user|admin|super_admin`), `status` (`active|banned|unverified|locked|deleted|all`;
default hides deleted), `member` (`1|0`), `creator` (`1`), `sort`
(`newest|oldest|last_login|email`).
Item: `{ id, email, username, display_name, role, email_verified_at, totp_enabled, last_login_at, last_ip, banned_at, ban_reason, deleted_at, created_at, is_member, brand_count }`.

### GET /api/admin/users/:id — admin

```json
{
  "user": { "id": "", "email": "", "username": "", "display_name": "", "role": "user", "email_verified_at": null, "totp_enabled": false,
            "avatar_key": null, "avatar_url": null, "bio": "", "prefs": {}, "marketing_opt_in": false, "last_login_at": null, "last_ip": null,
            "banned_at": null, "ban_reason": null, "deleted_at": null, "created_at": "", "failed_logins": 0, "locked_until": null, "email_unsubscribed_at": null },
  "brands": [{ "id": "", "slug": "", "name": "", "kind": "creator", "role": "owner", "verified_at": null, "suspended_at": null }],
  "orders": [{ "id": "", "status": "paid", "total_cents": 0, "provider": "", "created_at": "", "paid_at": null, "refunded_at": null, "summary": "" }],
  "membership": { "active": false, "current": null, "history": [{ "id": "", "plan": "monthly", "status": "active", "provider": "", "price_cents": 0,
                  "current_period_start": "", "current_period_end": "", "cancel_at_period_end": false, "canceled_at": null, "created_at": "" }] },
  "wallet": { "credit_cents": 0, "page_credits": 0, "updated_at": null },
  "wallet_log": [{ "id": "", "kind": "", "credit_cents": 0, "page_credits": 0, "note": "", "created_at": "" }],
  "logins": [{ "id": "", "ip": "", "user_agent": "", "success": true, "reason": "ok", "created_at": "" }],
  "sessions": [{ "ip": "", "user_agent": "", "created_at": "", "last_seen_at": "", "expires_at": "" }],
  "stats": { "owned_releases": 0, "comments": 0, "follows": 0, "reports_against": 0, "spent_cents": 0 }
}
```
Latest 25 orders / wallet entries / logins. `membership.current` has the same shape as a history row.

### Actions
Only a super admin can act on another staff account; nobody can ban, delete or
restore themselves.

| Method & path | Who | Body | Response | Audit |
|---|---|---|---|---|
| POST `/api/admin/users/:id/role` | super | `{ role: "user"\|"admin"\|"super_admin" }` | `{ ok, role }`. `409` if it would remove the last super admin | `user.role` |
| POST `/api/admin/users/:id/ban` | admin | `{ reason }` (3+ chars) | `{ ok }`. Ends all sessions | `user.ban` |
| POST `/api/admin/users/:id/unban` | admin | – | `{ ok }` | `user.unban` |
| POST `/api/admin/users/:id/logout` | admin | – | `{ ok, sessions_ended }` | `user.force_logout` |
| POST `/api/admin/users/:id/verify-email` | admin | – | `{ ok }` | `user.verify_email` |
| POST `/api/admin/users/:id/grant-membership` | admin | `{ days: 1–3650, note? }` | `{ ok, subscription_id, current_period_end }`. Extends an existing grant, else starts one (provider `grant`, price 0) | `user.grant_membership` |
| POST `/api/admin/users/:id/wallet` | super | `{ credit_cents?: int, page_credits?: int, note }` (deltas, may be negative; note required) | `{ ok, wallet: { credit_cents, page_credits } }`. `400` if a balance would go below zero | `user.wallet_adjust` |
| DELETE `/api/admin/users/:id` | admin | `{ anonymise?: boolean, reason? }` | `{ ok }`. Soft delete; `anonymise` scrubs the profile and frees the email/username (cannot be restored) | `user.delete` |
| POST `/api/admin/users/:id/restore` | admin | – | `{ ok }` | `user.restore` |

---

## 3. Brands

### GET /api/admin/brands — admin
Filters: `q` (name, slug), `kind` (`creator|publisher`), `status`
(`verified|unverified|suspended|kind_requested|deleted`), `sort` (`newest|name|balance`).
Item: `{ id, slug, name, kind, kind_requested, avatar_key, avatar_url, country, verified_at, suspended_at, suspend_reason, sale_share_bps, sub_share_bps, tip_share_bps, created_at, series_count, member_count, balance_cents }`.

### GET /api/admin/brands/:id — admin

```json
{
  "brand": { "id": "", "slug": "", "name": "", "kind": "creator", "kind_requested": null, "bio": "", "avatar_key": null, "avatar_url": null,
             "banner_key": null, "banner_url": null, "website": null, "socials": {}, "country": null, "timezone": null,
             "sale_share_bps": null, "sub_share_bps": null, "tip_share_bps": null, "tips_enabled": true, "monthly_goal_cents": null,
             "primary_language": "en", "verified_at": null, "suspended_at": null, "suspend_reason": null, "deleted_at": null, "created_at": "", "payout_method": null },
  "members": [{ "id": "", "email": "", "username": "", "display_name": "", "role": "owner", "created_at": "" }],
  "series": [{ "id": "", "slug": "", "title": "", "visibility": "public", "access_model": "free", "mature": false, "takedown_at": null, "follower_count": 0, "read_count": 0, "created_at": "" }],
  "balance": { "balance_cents": 0, "available_cents": 0, "pending_cents": 0 },
  "earned_by_kind": { "sale": 0, "subscription": 0, "tip": 0, "payout": 0, "refund": 0, "adjustment": 0 },
  "payouts": [{ "id": "", "amount_cents": 0, "status": "requested", "method": "", "reference": null, "created_at": "", "reviewed_at": null, "paid_at": null }],
  "shares": { "defaults": { "sale_share_bps": 8500, "sub_share_bps": 8000, "tip_share_bps": 9500 },
              "effective": { "sale_share_bps": 8500, "sub_share_bps": 8000, "tip_share_bps": 9500 } }
}
```
Share overrides on `brand` are `null` when the platform default applies.
`earned_by_kind` only lists kinds that have rows. `pending_cents` is money
still inside the payout hold.

### Actions

| Method & path | Who | Body | Response | Audit |
|---|---|---|---|---|
| POST `/api/admin/brands/:id/verify` | admin | `{ verified?: boolean }` (default true) | `{ ok, verified_at }` | `brand.verify` / `brand.unverify` |
| POST `/api/admin/brands/:id/kind-request` | admin | `{ approve: boolean, note? }` | `{ ok, kind }`. `400` if nothing is pending. Owners are notified | `brand.kind_approve` / `brand.kind_deny` |
| PATCH `/api/admin/brands/:id/shares` | super | any of `sale_share_bps`, `sub_share_bps`, `tip_share_bps`: 0–10000 or `null` (= platform default) | `{ ok, sale_share_bps, sub_share_bps, tip_share_bps }` | `brand.shares` (with diff) |
| POST `/api/admin/brands/:id/suspend` | admin | `{ reason }` | `{ ok }`. Owners are notified | `brand.suspend` |
| POST `/api/admin/brands/:id/unsuspend` | admin | – | `{ ok }` | `brand.unsuspend` |
| GET `/api/admin/brands/:id/ledger` | admin | query `kind` (`sale|subscription|tip|payout|refund|adjustment`) | list + `balance`. Item: `{ id, kind, amount_cents, gross_cents, series_id, series_title, release_id, order_id, payout_id, month, note, available_at, created_at }` | – |
| POST `/api/admin/brands/:id/ledger` | super | `{ amount_cents: non-zero int, note }` | `{ ok, ledger_id, balance }`. `400` if the balance would go below zero | `brand.ledger_adjust` |

---

## 4. Catalogue moderation

### GET /api/admin/series — admin
Filters: `q` (title, slug, brand name), `visibility` (`draft|public|unlisted`),
`access_model` (`blocked|free|premium`), `type`, `publisher_id`, `mature` (`1|0`),
`takedown` (`1|0`), `featured` (`1`), `reported` (`1`), `sort` (`newest|updated|reads|title`).
Item: `{ id, slug, title, type, visibility, access_model, mature, cover_key, cover_url, takedown_at, takedown_reason, follower_count, read_count, created_at, updated_at, publisher_id, publisher_name, publisher_slug, release_count, open_reports, featured_slots: ["hero"] }`.

| Method & path | Who | Body | Response | Audit |
|---|---|---|---|---|
| POST `/api/admin/series/:id/takedown` | admin | `{ reason }` | `{ ok }`. Removes it from featured rows; brand owners get a notification and an email with the reason | `series.takedown` |
| POST `/api/admin/series/:id/restore` | admin | – | `{ ok }`. Owners notified | `series.restore` |
| POST `/api/admin/series/:id/mature` | admin | `{ mature: boolean }` | `{ ok, mature }`. Owners notified when set | `series.mature` |
| POST `/api/admin/series/:id/feature` | admin | `{ featured: boolean, slot?: "hero"\|"staff_picks"\|"spotlight" }` (default `staff_picks`) | `{ ok }`. Only public, not-taken-down series | `series.feature` / `series.unfeature` |

### GET /api/admin/reports — admin
Filters: `status` (`open` default, `actioned|dismissed|all`), `target_kind`
(`series|release|comment|publisher|user`), `target_id`. Open reports are oldest first.
Item: `{ id, target_kind, target_id, reason, detail, status, created_at, resolved_at, reporter_id, reporter_username, resolved_by, resolved_by_username, open_on_target, target }`.
`target` is `null` if the thing no longer exists, otherwise an object with a
`label` plus, by kind:
series `{ url, id, title, slug, takedown_at, publisher_id }`;
release `{ url, id, title, series_id, series_title, series_slug, takedown_at }`;
comment `{ id, body, hidden_at, deleted_at, series_id, user_id, username, series_title }`;
publisher `{ url, id, name, slug, suspended_at }`;
user `{ id, username, email, banned_at }`.

### POST /api/admin/reports/:id/resolve — admin

```json
{ "decision": "action", "hide_comment": true, "takedown_series": false, "ban_user": true, "suspend_brand": false,
  "reason": "Abusive comments", "close_same_target": true }
```
`decision`: `action` or `dismiss`. With `action`, the chosen steps run in one
call: `hide_comment` (comment reports); `takedown_series` (series, release or
comment reports: takes down the series involved); `ban_user` (user reports, or
the author of a reported comment); `suspend_brand` (publisher reports).
`reason` is used for the takedown / ban / suspension (default: "Reported:
<report reason>"). `close_same_target` (default true) closes every other open
report on the same target. A step that does not fit the report is a `400` and
nothing is closed.
Response: `{ ok, status: "actioned"|"dismissed", steps: ["comment_hidden","series_taken_down","user_banned","brand_suspended"] | ["noted"], closed: number }`.
Audit: `report.actioned` / `report.dismissed`, plus the audit row of each step.

### Comments

| Method & path | Who | Body / query | Response | Audit |
|---|---|---|---|---|
| GET `/api/admin/comments` | admin | `q`, `series_id`, `user_id`, `status` (`visible|hidden|deleted|reported`) | list. Item: `{ id, body, created_at, hidden_at, deleted_at, parent_id, release_id, series_id, series_title, series_slug, user_id, username, user_banned_at, open_reports }` | – |
| POST `/api/admin/comments/:id/hide` | admin | `{ hidden?: boolean }` (default true) | `{ ok, hidden }` | `comment.hide` / `comment.unhide` |
| DELETE `/api/admin/comments/:id` | admin | – | `{ ok }` (soft delete) | `comment.delete` |

---

## 5. Finance

### Orders

**GET /api/admin/orders** — admin. Filters: `status` (`pending|paid|failed|refunded`),
`provider`, `user_id`, `publisher_id`, `q` (buyer email/username, exact
processor reference or order id), `from`, `to`.
Returns list + `paid_cents` (sum of paid orders matching the filter).
Item: `{ id, status, total_cents, fee_cents, provider, provider_ref, created_at, paid_at, refunded_at, user_id, email, username, item_count, summary }`.

**GET /api/admin/orders/:id** — admin.

```json
{
  "order": { "id": "", "user_id": "", "status": "paid", "total_cents": 0, "fee_cents": 0, "credit_cents": 0, "provider": "", "provider_ref": null,
             "payment_ref": null, "discount_code_id": null, "discount_code": null, "ip": null, "meta": {}, "created_at": "", "paid_at": null,
             "refunded_at": null, "email": "", "username": "", "display_name": "" },
  "items": [{ "id": "", "kind": "release", "description": "", "price_cents": 0, "creator_cents": 0, "release_id": null, "series_id": null,
              "publisher_id": null, "bundle_id": null, "publisher_name": null, "series_title": null }],
  "ledger": [{ "id": "", "kind": "sale", "amount_cents": 0, "gross_cents": 0, "note": "", "created_at": "", "publisher_id": "", "publisher_name": "" }],
  "entitlements": [{ "release_id": "", "source": "purchase", "can_download": false, "title": "" }],
  "gift_cards": [{ "id": "", "amount_cents": 0, "balance_cents": 0, "recipient_email": null, "redeemed_at": null }]
}
```
`order` is the full `orders` row plus the buyer's `email`, `username`, `display_name` and the `discount_code` text.

**POST /api/admin/orders/:id/refund** — admin.
Body: `{ reason (3+ chars), to_wallet?: boolean, provider_refunded?: boolean }`.

- Default: the card payment is returned through the payment processor
  (`lib/payments.ts` `refundOrder`), then the books are reversed. If the
  processor refuses, the response is `502` and nothing changes.
- `to_wallet: true`: the reader gets store credit instead; the processor is not called.
- `provider_refunded: true` is only needed on an install without the payments
  module: it records a refund you already made in the processor's dashboard.
  Without it such an install answers `409 code: "provider_refund_unavailable"`.

Either way creator earnings are reversed in the ledger and the reader loses
ownership of the releases. `409` if already refunded, `400` if not paid.
Response: `{ ok, method: "provider"|"wallet"|"recorded"|"none", creator_cents_reversed, warnings: [] }`
(`none` = nothing had been charged to a card, e.g. sandbox or fully paid with store credit).
Audit: `order.refund`.

### Memberships

**GET /api/admin/memberships** — admin. Filters: `status` (`current` = active
or past due and not expired; or `pending|active|past_due|canceled|expired`),
`plan` (`monthly|annual`), `provider` (`grant` = complimentary), `q` (email/username).
Returns list + `summary: { active_members, past_due, cancelling, complimentary, mrr_cents }`.
Item: `{ id, plan, status, provider, provider_ref, price_cents, current_period_start, current_period_end, cancel_at_period_end, canceled_at, created_at, user_id, email, username }`.

**GET /api/admin/memberships/:id** — admin.
`{ membership: <item>, charges: [{ id, period_start, period_end, amount_cents, fee_cents, status, attempts, last_error, payment_ref, paid_at, refunded_at, created_at }], months: [{ month: "2026-10", gross_cents, fee_cents, settled_at }] }`.

**POST /api/admin/membership-charges/:id/refund** — admin. Body `{ reason }`.
Refunds that payment through the processor and ends the membership.
`{ ok }`; `409` if the charge is not paid; `502` if the processor refuses.
Audit: `membership_charge.refund`.

### Payouts — super

**GET /api/admin/payouts**. Filters: `status` (`requested` default,
`approved|paid|rejected|all`), `publisher_id`. Requested payouts are oldest first.
Returns list + `totals: [{ status, count, cents }]`.
Item: `{ id, publisher_id, publisher_name, publisher_slug, publisher_suspended_at, amount_cents, status, method, destination, note, reference, created_at, reviewed_at, paid_at, requested_by, requested_by_email, reviewed_by, reviewed_by_username, balance_cents, available_cents, debited }`
(`debited` = a ledger row for this payout already exists).

| Method & path | Body | Response | Notes | Audit |
|---|---|---|---|---|
| POST `/api/admin/payouts/:id/approve` | `{ note? }` | `{ ok, payout, balance }` | Only from `requested`. In one transaction, under a lock on the brand: checks the available balance covers the amount, inserts the negative `payout` ledger row, marks it approved. `400` if the balance is short or the brand is suspended; `409` if not `requested` | `payout.approve` |
| POST `/api/admin/payouts/:id/paid` | `{ reference, note? }` | `{ ok, payout }` | Only from `approved` (`409` otherwise) | `payout.paid` |
| POST `/api/admin/payouts/:id/reject` | `{ note }` (3+ chars) | `{ ok, payout, returned_cents }` | From `requested` or `approved`. Money already debited goes back to the brand as an `adjustment` row | `payout.reject` |

Each sends the `payout_update` email and an in-app notification to the brand
owners and the person who asked. `payout` is the full `payouts` row.

### Settlement — super

**GET /api/admin/settlement** → `{ months: [{ month: "2026-10", subscribers, gross_cents, fee_cents, unsettled, closed, ran_at, creator_cents, platform_cents, ran_by_username }] }`
(one row per month that has membership payments; `closed` = the month is over;
`ran_at` null = not settled yet).

**GET /api/admin/settlement/:month/preview** (`:month` = `YYYY-MM`) →
`{ month, settled: <settlements row or null>, preview }`. `preview` comes from
the settlement engine (`jobs/settlement.ts` `previewSettlement`):
`{ month, already_settled, subscribers, gross_cents, fee_cents, creator_cents, platform_cents, pool_cents, undistributed_cents, series: [{ series_id, publisher_id, pages, net_cents, creator_cents, platform_cents }] }`.
On an install without that module it is an estimate with `source: "estimate"`,
a `note`, and `publishers: [{ publisher_id, name, pages, readers, creator_cents }]` instead of `series`.

**POST /api/admin/settlement/:month/run** → `{ ok, month, settlement: <settlements row>, result }`.
`400` for the current or a future month. Running a settled month again changes
nothing. `501 code: "settlement_missing"` if the engine is not installed.
Audit: `settlement.run`.

### Platform codes

**GET /api/admin/codes** — admin. Platform-issued codes only (not brands' own).
Filters: `kind` (`membership|credits|discount`), `batch_id`, `q` (code, batch
label, assigned email), `status` (`active|disabled|used`).
Item: `{ id, code, kind, percent_off, membership_days, page_credits, max_redemptions, redeemed_count, batch_label, batch_id, assigned_email, starts_at, expires_at, disabled_at, created_at, created_by_username }`.

**POST /api/admin/codes** — admin.

```json
{ "kind": "membership", "membership_days": 30, "quantity": 25, "batch_label": "Convention giveaway", "expires_at": "2027-01-01T00:00:00Z" }
```
`kind` decides the required field: `membership` → `membership_days` (1–3650);
`credits` → `page_credits`; `discount` → `percent_off` (1–100, applies at
checkout). Optional: `code` (your own text, 4–40 letters/digits/dashes, only
with `quantity` 1), `quantity` (1–500 random codes), `max_redemptions` (number
or `null` for unlimited; default 1 for random codes, unlimited for a named
code), `starts_at`, `expires_at`, `batch_label`, `assigned_email`.
Response: `{ ok, batch_id, codes: [{ id, code, kind, percent_off, membership_days, page_credits, max_redemptions, expires_at }] }`.
`409` if the code exists. Audit: `code.create`.

**POST /api/admin/codes/:id/disable** — admin. `{ disabled?: boolean }` → `{ ok, disabled_at }`. Audit: `code.disable` / `code.enable`.

### Gift cards

| Method & path | Who | Body / query | Response | Audit |
|---|---|---|---|---|
| GET `/api/admin/gift-cards` | admin | `q` (code, recipient), `status` (`redeemed|unredeemed|void`) | list. Item: `{ id, code, amount_cents, balance_cents, recipient_email, message, order_id, created_at, redeemed_at, purchaser_id, purchaser_username, redeemed_by, redeemed_by_username }` | – |
| POST `/api/admin/gift-cards` | super | `{ amount_cents: 100–100000, recipient_email?, message?, send_email?: boolean (default true) }` | `{ ok, gift_card: { id, code, amount_cents, balance_cents, recipient_email, message, created_at }, email_id }` | `gift_card.create` |
| POST `/api/admin/gift-cards/:id/void` | super | – | `{ ok }`; `400` if already redeemed | `gift_card.void` |

---

## 6. Storefront

### Featured rows
Slots: `hero`, `staff_picks`, `spotlight`. `staff_picks` and `spotlight`
entries are always a series. A `hero` entry is a series, or a custom card
(`headline` + `url`, image uploaded separately).

Item (all endpoints): `{ id, slot, series_id, headline, blurb, url, image_key, image_url, position, starts_at, ends_at, created_at, series_title, series_slug, series_cover_key, series_cover_url, series_visibility, series_takedown_at, live }`
(`live` = inside its schedule window right now).

| Method & path | Who | Body | Response | Audit |
|---|---|---|---|---|
| GET `/api/admin/featured` | admin | query `slot?` | `{ items }` ordered by slot, position | – |
| POST `/api/admin/featured` | admin | `{ slot, series_id?, headline?, blurb?, url?, position?, starts_at?, ends_at? }` | `{ ok, item }` | `featured.create` |
| PATCH `/api/admin/featured/:id` | admin | any of the same fields (`null` clears `series_id`, `headline`, `url`, `starts_at`, `ends_at`) | `{ ok, item }` | `featured.update` |
| POST `/api/admin/featured/reorder` | admin | `{ slot, ids: [id, ...] }` in display order | `{ ok }` | `featured.reorder` |
| POST `/api/admin/featured/:id/image` | admin | `multipart/form-data`, field `file` (JPG/PNG/WebP/AVIF, max 20 MB) | `{ ok, image_key, image_url }`; stored as WebP under `public/featured/` | `featured.image` |
| DELETE `/api/admin/featured/:id` | admin | – | `{ ok }` | `featured.delete` |

`url` must start with `/` or `http(s)://`. A new item goes to the end of its
slot unless `position` is given. Only public, not-taken-down series can be featured.

### Announcements
`kind`: `bar` (strip across the top) or `modal` (promo pop-up).
Item: `{ id, kind, headline, body, cta_label, cta_url, image_key, image_url, starts_at, ends_at, active, created_at, live }`.

| Method & path | Who | Body | Response | Audit |
|---|---|---|---|---|
| GET `/api/admin/announcements` | admin | – | `{ items }` newest first | – |
| POST `/api/admin/announcements` | admin | `{ kind, headline, body?, cta_label?, cta_url?, starts_at?, ends_at?, active? }` | `{ ok, item }` | `announcement.create` |
| PATCH `/api/admin/announcements/:id` | admin | any of the same | `{ ok, item }` | `announcement.update` |
| POST `/api/admin/announcements/:id/image` | admin | multipart `file` | `{ ok, image_key, image_url }` | `announcement.image` |
| DELETE `/api/admin/announcements/:id` | admin | – | `{ ok }` | `announcement.delete` |

A button needs both `cta_label` and `cta_url`. `starts_at` defaults to now;
`ends_at` null = until switched off.

### Footer pages (CMS)
Fixed slugs: `about`, `contact`, `content-policy`, `publisher-sla`, `privacy`,
`privacy-choices`, `terms`, `publisher-terms`, `faq`. `body` is Markdown.
The seeded text is a first draft marked as such, for the owner to review.

| Method & path | Who | Body | Response | Audit |
|---|---|---|---|---|
| GET `/api/admin/pages` | admin | – | `{ items: [{ slug, title, length, updated_at, updated_by_username }] }` (always all nine) | – |
| GET `/api/admin/pages/:slug` | admin | – | `{ page: { slug, title, body, updated_at } }` | – |
| PUT `/api/admin/pages/:slug` | admin | `{ title, body }` | `{ ok, page }` | `page.update` |

### News
`published_at`: `null` = draft, future = scheduled, past = live. `body` is Markdown.

| Method & path | Who | Body / query | Response | Audit |
|---|---|---|---|---|
| GET `/api/admin/news` | admin | `q`, `status` (`draft|scheduled|published`) | list. Item: `{ id, slug, title, excerpt, cover_key, cover_url, published_at, created_at, author_username }` | – |
| GET `/api/admin/news/:id` | admin | – | `{ post: { id, slug, title, excerpt, body, cover_key, cover_url, author_id, published_at, created_at } }` | – |
| POST `/api/admin/news` | admin | `{ title, body, excerpt?, slug?, published_at? }` | `{ ok, post }` (slug made unique from the title) | `news.create` |
| PATCH `/api/admin/news/:id` | admin | any of the same | `{ ok, post }`; `409` if the slug is taken | `news.update` |
| POST `/api/admin/news/:id/cover` | admin | multipart `file` | `{ ok, cover_key, cover_url }` | `news.cover` |
| DELETE `/api/admin/news/:id` | admin | – | `{ ok }` | `news.delete` |

### Feedback inbox

| Method & path | Who | Body / query | Response | Audit |
|---|---|---|---|---|
| GET `/api/admin/feedback` | admin | `status` (`new|read|resolved|all`), `category`, `q` | list + `counts: { new, read, resolved }`. Item: `{ id, category, body, page_url, status, created_at, user_id, email, username }` | – |
| POST `/api/admin/feedback/:id/status` | admin | `{ status: "new"\|"read"\|"resolved" }` | `{ ok, status }` | `feedback.status` |

---

## 7. Settings — super

### GET /api/admin/settings

```json
{
  "sections": {
    "site": { "name": "", "tagline": "", "support_email": "", "currency": "usd", "socials": {}, "registration_open": true, "maintenance": false },
    "revenue": { "sale_share_bps": 8500, "sub_share_bps": 8000, "tip_share_bps": 9500, "payout_minimum_cents": 2000, "payout_hold_days": 7, "fee_pct_bps": 290, "fee_fixed_cents": 30 },
    "membership": { "name": "", "monthly_cents": 599, "annual_cents": 5900, "trial_days": 0, "page_credit_cents": 5 },
    "storage": { "driver": "local", "r2_account_id": "", "r2_bucket": "", "r2_access_key_id": "", "r2_secret_access_key": { "set": false }, "r2_public_url": "" },
    "email": { "provider": "log", "sendgrid_api_key": { "set": false }, "sendgrid_webhook_key": { "set": false }, "mailgun_api_key": { "set": false },
               "mailgun_domain": "", "mailgun_webhook_signing_key": { "set": false }, "from_email": "", "from_name": "", "reply_to": "", "queue_paused": false },
    "payments": { "provider": "sandbox", "divinity_api_url": "", "divinity_partner_id": "", "divinity_api_key": { "set": false },
                  "divinity_webhook_secret": { "set": false }, "divinity_checkout_logo_url": "" },
    "security": { "recaptcha_site_key": "", "recaptcha_secret_key": { "set": false }, "recaptcha_enabled": false, "bot_blocker_enabled": true,
                  "rate_limit_per_minute": 240, "admin_2fa_required": false, "max_login_attempts": 8, "password_min_length": 10 },
    "analytics": { "ga_measurement_id": "", "sentry_dsn": "" }
  },
  "secrets": { "storage": ["r2_secret_access_key"], "email": ["sendgrid_api_key", "..."], "payments": ["divinity_api_key", "divinity_webhook_secret"], "security": ["recaptcha_secret_key"], "site": [] },
  "info": {
    "app_url": "https://nsfwcomix.com",
    "environment": "production",
    "webhooks": { "divinity": "https://.../api/webhooks/divinity", "sendgrid": "https://.../api/webhooks/email/sendgrid", "mailgun": "https://.../api/webhooks/email/mailgun" },
    "cron_secret_set": true
  }
}
```
Secret fields are never returned: they appear as `{ "set": boolean }`.
`info.webhooks` are the addresses the owner registers with each provider:
show `divinity` on the Payments form and the email ones on the Email form.
`sendgrid_webhook_key` is SendGrid's signed-event-webhook *verification key*
(the base64 public key from their settings page).

### PATCH /api/admin/settings

```json
{ "section": "email", "data": { "provider": "sendgrid", "sendgrid_api_key": "", "from_email": "hello@nsfwcomix.com" }, "clear": [] }
```
- Send only the fields being changed. Unknown fields are a `400`.
- **A blank secret field keeps the stored value.** To remove a secret, list it in `clear`.
- Validation per section (ranges, formats) plus rules across fields: `storage.driver = r2`
  needs all four R2 credentials; an email provider needs `from_email` and its
  key (and `mailgun_domain`); `payments.provider = divinity` needs API URL
  (https in production), partner ID and API key; **`payments.provider =
  sandbox` is refused in production**; `recaptcha_enabled` needs both keys;
  `socials` is `{ name: "https://..." }`.
- Response: `{ ok, section, changed: ["field"], value: <masked section>, notes: ["sentence"] }`.
  Show `notes` to the user (e.g. switching storage driver does not move files;
  turning on required 2FA while you have none).
- Audit: `settings.update` with `meta.diff`: non-secret fields as
  `{ from, to }`, secret fields only as `"secret set" | "secret replaced" | "secret cleared"`.

### Connection tests
All `POST`, super. Body: the form's current values for that integration as a
flat object of strings (optional; blank or missing fields fall back to what
is stored, so a saved secret can be tested without retyping it). Response:
`{ ok: boolean, message: "sentence", detail?: {} }` with HTTP 200 either way.
A network failure reads "Could not reach ...", never a pass. Audit: `settings.test`.

| Path | Fields read | What it does |
|---|---|---|
| `/api/admin/settings/test/r2` | `r2_account_id`, `r2_bucket`, `r2_access_key_id`, `r2_secret_access_key` | HeadBucket against R2 |
| `/api/admin/settings/test/sendgrid` | `sendgrid_api_key` | Reads the key's scopes; fails if it cannot send mail |
| `/api/admin/settings/test/mailgun` | `mailgun_api_key`, `mailgun_domain` | Looks the domain up; fails unless it is active |
| `/api/admin/settings/test/divinity` | `divinity_api_url`, `divinity_partner_id`, `divinity_api_key` | Read-only `lookup-payment` for an id that cannot exist: rejected credentials fail, any other JSON answer passes. Response also has `webhook_url` |
| `/api/admin/settings/test/recaptcha` | `recaptcha_site_key`, `recaptcha_secret_key` | Format check, then asks Google whether it knows the secret. If Google cannot be reached: `ok: true` with `detail.verified_with_google: false` and a message saying so |
| `/api/admin/settings/test/email` | – | Queues a real message to your own address through the normal queue. `{ ok, message, email_id, to }`; follow `email_id` in the email log |

---

## 8. Email centre

Email statuses: `queued`, `sending`, `sent`, `failed`, `suppressed`, `cancelled`.

### GET /api/admin/emails — admin
Filters: `status`, `template`, `category` (`transactional|notification|marketing`),
`recipient` (address contains), `q` (subject contains), `user_id`, `publisher_id`,
`engagement` (`opened|clicked`), `from`, `to` (created date range).
Returns list + `queue` (see below).
Item: `{ id, to_email, user_id, template, category, subject, status, attempts, provider, error, send_after, created_at, sent_at, opened_at, clicked_at }`.

### GET /api/admin/emails/queue — admin
`{ paused, provider, queued, due, sending, failed, sent_24h, suppressed_24h, opened_24h, oldest_due }`.

### GET /api/admin/emails/:id — admin
`{ email: { ...item, html, text_body, provider_id, publisher_id, username, publisher_name }, suppression: { reason, source, created_at } | null }`.
`html` is the full rendered message: show it in a sandboxed iframe (`srcdoc`, no scripts).

| Method & path | Who | Body | Response | Audit |
|---|---|---|---|---|
| POST `/api/admin/emails/:id/retry` | admin | – | `{ ok }`. Only `failed`, `suppressed` or `cancelled` (`409` otherwise); `400` while the address is on the suppression list | `email.retry` |
| POST `/api/admin/emails/:id/cancel` | admin | – | `{ ok }`. Only `queued` (`409` otherwise) | `email.cancel` |
| POST `/api/admin/emails/retry-failed` | admin | `{ days?: 1–90 }` (default 7) | `{ ok, requeued }` | `email.retry_failed` |
| POST `/api/admin/emails/queue/pause` | super | – | `{ ok, paused: true }` | `email.queue_pause` |
| POST `/api/admin/emails/queue/resume` | super | – | `{ ok, paused: false }` | `email.queue_resume` |

### Templates

**GET /api/admin/email-templates** — admin →
`{ items: [{ key, category, vars: ["name","url","site"], customised, subject, html, default_subject, default_html, updated_at, updated_by_username }], syntax }`.
`subject`/`html` are what is sent now (the override if `customised`). `html`
is the inner body; the site wrapper is added when sending. Placeholders:
`{{name}}` for a value, `{{button:Label|url}}` for a button linking to the `url` value.

| Method & path | Who | Body | Response | Audit |
|---|---|---|---|---|
| PUT `/api/admin/email-templates/:key` | super | `{ subject, html }` | `{ ok }`. `400` if it uses a placeholder the template does not have, or contains scripts | `email_template.save` |
| DELETE `/api/admin/email-templates/:key` | super | – | `{ ok, reset }` (back to the built-in text) | `email_template.reset` |
| POST `/api/admin/email-templates/:key/preview` | admin | `{ subject?, html?, vars?: { name: "..." } }` | `{ subject, html, unknown_vars: [] }`: rendered with sample values inside the site wrapper. Send `subject`/`html` to preview unsaved edits | – |

### Suppression list
Addresses that are never emailed (hard bounces and spam complaints are added automatically by the webhooks).

| Method & path | Who | Body / query | Response | Audit |
|---|---|---|---|---|
| GET `/api/admin/email-suppressions` | admin | `q`, `source` (`manual|sendgrid|mailgun`) | list. Item: `{ email, reason, source, created_at }` | – |
| POST `/api/admin/email-suppressions` | admin | `{ email, reason? }` | `{ ok }` | `email_suppression.add` |
| DELETE `/api/admin/email-suppressions/:email` | admin | – (URL-encode the address) | `{ ok }` | `email_suppression.remove` |

### Provider webhooks (called by SendGrid / Mailgun, not by the web app)

| Path | Verification |
|---|---|
| POST `/api/webhooks/email/sendgrid` | ECDSA signature (`X-Twilio-Email-Event-Webhook-Signature` + `-Timestamp`) against `email.sendgrid_webhook_key` |
| POST `/api/webhooks/email/mailgun` | HMAC-SHA256 of `timestamp + token` with `email.mailgun_webhook_signing_key`, timestamp within 24 h |

`503` while the key is not saved (nothing is accepted unverified), `401` on a
bad signature, otherwise `{ ok, received, applied: { delivered?, open?, click?, bounce?, dropped?, spam?, unsubscribe?, ignored? } }`.
Effects: open → `emails.opened_at`; click → `clicked_at` (and `opened_at`);
hard bounce → email `failed` + address suppressed; dropped → `failed`; spam
complaint → address suppressed + user unsubscribed; unsubscribe →
`users.email_unsubscribed_at` (stops notification and marketing mail only).
Events are matched by the `email_id` custom arg (SendGrid) / user variable (Mailgun).

---

## 9. Security

### Overview, blocks, feeds — super

**GET /api/admin/security/overview** →
`{ blocked_ips, blocked_24h, suspicious_24h, failed_logins_24h, logins_24h, active_sessions, users_online, locked_accounts, staff, staff_without_2fa, top_reasons: [{ reason, count }], settings: { bot_blocker_enabled, rate_limit_per_minute, admin_2fa_required, recaptcha_enabled } }`.

**GET /api/admin/security/blocked-ips** — `status` (`active` default, `expired|all`), `q` (IP, reason, user agent).
Item: `{ id, ip_address, reason, violation_count, blocked_at, expires_at, last_user_agent, last_path, active, permanent }`.

**POST /api/admin/security/blocked-ips** — `{ ip, reason, hours?: 1–8760 | null }` (no `hours` = permanent)
→ `{ ok, item }`. `400` for an invalid address, your own address, or a
private/loopback address. Audit: `security.block_ip`.

**DELETE /api/admin/security/blocked-ips/:id** → `{ ok, ip_address, note }`.
Removes the block; the API stops refusing the address at once in the process
that handled the call and within a minute in the others, and the firewall
rule is removed within seconds where the watcher is installed. Audit: `security.unblock_ip`.

**GET /api/admin/security/suspicious** — `ip`, `q`, `from`, `to`.
Item: `{ id, ip_address, reason, path, user_agent, created_at, blocked }`.

**GET /api/admin/security/logins** — `success` (`1|0`), `ip`, `email`, `reason`, `user_id`, `from`, `to`.
Item: `{ id, user_id, username, role, email, ip, user_agent, success, reason, created_at }`
(`reason`: `ok`, `mfa_ok`, `password_invalid`, `mfa_pending`, `mfa_failed`, `banned`, `locked`).

### Two-factor authentication (your own account) — admin
Reachable even while required 2FA is locking the rest of `/api/admin`.

| Method & path | Body | Response | Audit |
|---|---|---|---|
| GET `/api/admin/security/2fa` | – | `{ enabled, required, enrolment_pending, backup_codes_left }` | – |
| POST `/api/admin/security/2fa/begin` | – | `{ secret, otpauth_url, qr_data_url }` (`qr_data_url` is a PNG data URL for an `<img>`). `409` if already on | `security.2fa_begin` |
| POST `/api/admin/security/2fa/confirm` | `{ code: "123456" }` | `{ ok, backup_codes: ["ABCDE-FGHJK", ...10] }`. Shown **once**: only hashes are stored | `security.2fa_enable` |
| POST `/api/admin/security/2fa/backup-codes` | `{ code }` | `{ ok, backup_codes }` (replaces the old ones) | `security.2fa_backup_codes` |
| POST `/api/admin/security/2fa/disable` | `{ password, code }` (`code` = app code or a backup code) | `{ ok, setup_required }` (`setup_required` = 2FA is mandatory, so enrolment is needed again) | `security.2fa_disable` |
| POST `/api/admin/security/2fa/reset/:id` — **super** | – | `{ ok }`. Clears another person's 2FA (lost device) and signs them out | `security.2fa_reset` |

Sign-in with 2FA is `POST /api/auth/login` with `totp` (see the auth docs): a
backup code works there once.

---

## 10. Logs

### Audit log — admin
**GET /api/admin/audit** — `actor_id`, `actor` (email/username contains),
`action` (`settings` matches every `settings.*`; `settings.update` matches
exactly), `target_kind`, `target_id`, `ip`, `q` (text inside the details), `from`, `to`.
Item: `{ id, action, target_kind, target_id, meta, ip, created_at, actor_id, actor_username, actor_email, actor_role }`.

**GET /api/admin/audit/facets** → `{ actions: [{ action, count }], target_kinds: [] }` for filter dropdowns.

### Error log — admin
Errors are grouped; one row per distinct error. `source`: `api|web|job`.

| Method & path | Body / query | Response | Audit |
|---|---|---|---|
| GET `/api/admin/errors` | `status` (`unresolved` default, `resolved|ignored|all`), `source`, `level`, `q`, `sort` (`last_seen|first_seen|count`) | list + `counts: { unresolved, resolved, ignored }`. Item: `{ id, title, source, endpoint, level, status, event_count, first_seen, last_seen }` | – |
| GET `/api/admin/errors/:id` | – | `{ error: { ...item, fingerprint, last_message, last_stack, last_meta } }` | – |
| POST `/api/admin/errors/:id/status` | `{ status: "unresolved"\|"resolved"\|"ignored" }` | `{ ok, status }` | `error.status` |
| POST `/api/admin/errors/bulk` | `{ ids: [] }` **or** `{ all_with_status }`, plus `{ status }` or `{ delete: true }` | `{ ok, affected }` | `error.bulk_status` / `error.bulk_delete` |

A resolved error reopens by itself if it happens again; an ignored one stays quiet.

### Cron runs — admin
**GET /api/admin/cron-runs** — `job`, `ok` (`1|0`). List +
`jobs: [{ job, runs, failures, last_run, last_success }]` (last 7 days).
Item: `{ id, job, ok, detail, started_at, finished_at, ms }`. In-process jobs
are named e.g. `email-queue`; runs triggered over HTTP are `cron:email-queue`.

---

## 11. Public endpoints (no sign-in)

| Method & path | Response |
|---|---|
| GET `/api/content/announcements` | `{ announcements: [{ id, kind: "bar"\|"modal", headline, body, cta_label, cta_url, image_url }] }` — only those live now |
| GET `/api/pages/:slug` | `{ page: { slug, title, body, updated_at } }` — `body` is Markdown; `404` for an unknown slug |
| GET `/api/news` | `{ posts: [{ slug, title, excerpt, cover_url, published_at }], total, page, limit }` (`?page`, `?limit` ≤ 50) |
| GET `/api/news/:slug` | `{ post: { slug, title, excerpt, cover_url, published_at, body, author_name } }` — `body` is Markdown |
| GET `/api/health` | `{ ok: true, db: true, db_ms, uptime_s }`, or `503 { ok: false, db: false, error }` |
| GET `/api/health/live` | `{ ok: true }` (process is up; touches nothing else) |
| POST `/api/track/error` | Body `{ message, stack?, url? }` → `{ ok: true }`. No CSRF token needed. 20 per 5 minutes per address, then `429`. Appears in the error log with source `web`, grouped by page path |

---

## 12. Cron endpoints

`GET` or `POST`, header `Authorization: Bearer $CRON_SECRET`. With
`CRON_SECRET` unset on the server every call is refused with `503`; a wrong
or missing token is `401`. Success: `{ ok: true, job, detail }`. Each run is
recorded in `cron_runs`.

| Path | Does |
|---|---|
| `/api/cron/email-queue` | Sends up to 50 queued emails and requeues stuck ones |
| `/api/cron/publish-scheduled` | Publishes releases whose scheduled time has passed |
| `/api/cron/cleanup` | Expired sessions and tokens, suspicious activity / cron runs older than 90 days, login events older than 180 days, blocks expired more than 7 days ago, closed error groups idle for 90 days |
| `/api/cron/settlement` | Settles last month (`?month=YYYY-MM` for another finished month). Already-settled months are skipped |

See `scripts/deploy/crontab.example`.

---

## Audit actions (for the audit viewer's labels)

`user.role`, `user.ban`, `user.unban`, `user.force_logout`, `user.verify_email`,
`user.grant_membership`, `user.wallet_adjust`, `user.delete`, `user.restore`,
`brand.verify`, `brand.unverify`, `brand.kind_approve`, `brand.kind_deny`,
`brand.shares`, `brand.suspend`, `brand.unsuspend`, `brand.ledger_adjust`,
`series.takedown`, `series.restore`, `series.mature`, `series.feature`,
`series.unfeature`, `report.actioned`, `report.dismissed`, `comment.hide`,
`comment.unhide`, `comment.delete`, `order.refund`, `membership_charge.refund`,
`payout.approve`, `payout.paid`, `payout.reject`, `settlement.run`,
`code.create`, `code.disable`, `code.enable`, `gift_card.create`,
`gift_card.void`, `featured.create`, `featured.update`, `featured.reorder`,
`featured.image`, `featured.delete`, `announcement.create`,
`announcement.update`, `announcement.image`, `announcement.delete`,
`page.update`, `news.create`, `news.update`, `news.cover`, `news.delete`,
`feedback.status`, `settings.update`, `settings.test`, `email.retry`,
`email.cancel`, `email.retry_failed`, `email.queue_pause`,
`email.queue_resume`, `email_template.save`, `email_template.reset`,
`email_suppression.add`, `email_suppression.remove`, `security.block_ip`,
`security.unblock_ip`, `security.2fa_begin`, `security.2fa_enable`,
`security.2fa_backup_codes`, `security.2fa_disable`, `security.2fa_reset`,
`error.status`, `error.bulk_status`, `error.bulk_delete`.
