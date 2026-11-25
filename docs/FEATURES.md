# NSFWComix feature catalog

Source: 36 screenshots of the GlobalComix creator and reader UI (Drive folder
"global comix shots", captured 23 Nov 2026), each read at full resolution.
Every feature seen is listed with the NSFWComix equivalent and where we go
further. The **Status** column is kept current as the build progresses:
`done`, `partial` (works, missing a listed detail), `todo`.

Legend for "Better": what NSFWComix does that the screenshots show GlobalComix
does not.

Status as of the first full build. `done` means built and exercised in a
browser or by automated tests in development. It does not mean proven in
production: nothing here has run against live R2, SendGrid, Mailgun or
Divinity payments yet. The `partial` rows:

- **1.6** install prompt only; there is no offline reading.
- **1.11** the interface-language setting is saved, but the interface is English only.
- **11.2** zoom and fit work; the editor fills the screen but has no browser-fullscreen button.
- **14.2** integrations are configurable and their connection tests run, but none has been proven against the live service.
- **14.5** membership, sales, refunds and the monthly split are built and tested against a stand-in processor only.

---

## 1. Global shell and navigation

| # | Seen in GlobalComix | NSFWComix | Better | Status |
|---|---|---|---|---|
| 1.1 | Left sidebar: Store, Library, Gold, Community | Sidebar: Store, Library, Unlimited, Community | | done |
| 1.2 | Legacy top bar: Comics, Downloads, Creators, Forums, News, Originals | Browse, Downloads shelf, Creators directory, Forums, News | One navigation system instead of two (their creator pages still use the old top bar) | done |
| 1.3 | Global search box ("Explore over 100,000 comics") | Search titles, creators, tags | Filters by genre/theme/audience/era/art style/format/price | done |
| 1.4 | Promo strip across the top with CTA ("Black Friday … $49 / Become a member") | Admin-managed announcement bar with CTA and schedule | | done |
| 1.5 | Promo modal on the store (sale price, strike-through, CTA) | Admin-managed promo modal, shown once per visitor | Dismiss is remembered | done |
| 1.6 | "Get the app" button | Installable PWA prompt | | partial |
| 1.7 | "Publish" button (sidebar and top bar) | "Publish" entry to Studio | | done |
| 1.8 | Social icons: YouTube, Discord, TikTok, X, Instagram | Admin-configurable social links | | done |
| 1.9 | Footer: About, Contact us, Content policy, Publisher SLA, Privacy policy, Your privacy choices, Terms of service, Blog, FAQ, Publisher Terms | Admin-editable legal/info pages | | done |
| 1.10 | "Hide AI Comics" footer toggle | Not needed | AI-generated comics are not accepted at all | done |
| 1.11 | Interface language picker (footer) | Interface language setting | | partial |
| 1.12 | Notification bell with unread count | Notification bell with unread count | | done |
| 1.13 | Direct-message icon | Direct messages | | done |
| 1.14 | "Home" link, "Me" avatar | Avatar opens account menu | | done |

## 2. Account menu (avatar flyout)

| # | Seen | NSFWComix | Status |
|---|---|---|---|
| 2.1 | Username + "View profile" | Same | done |
| 2.2 | "Get Gold — unlimited access" upsell row | Unlimited upsell row (hidden for members) | done |
| 2.3 | Account settings | Same | done |
| 2.4 | Favorite genre + Change | Same | done |
| 2.5 | Redeem code | Same | done |
| 2.6 | Gift cards | Same | done |
| 2.7 | Purchases | Same | done |
| 2.8 | Membership | Same | done |
| 2.9 | Submit feedback | Same (lands in /admin inbox) | done |
| 2.10 | Creator block: brand avatar, "View creator profile" | Same, one block per brand you belong to | done |
| 2.11 | Page settings | Brand settings | done |
| 2.12 | Analytics | Same | done |
| 2.13 | Manage series | Same | done |
| 2.14 | Log out | Same | done |

## 3. Onboarding

| # | Seen | NSFWComix | Status |
|---|---|---|---|
| 3.1 | "Pick one to start" favorite-genre picker: Superhero & Action; Sci-Fi & Fantasy; Manga, Action & Adventure; Manga, Romance & Fantasy; Horror & Mystery; A little bit of everything. Save / Cancel. | Same six-way picker, tunes the store rows | done |

## 4. Account settings

| # | Seen | NSFWComix | Status |
|---|---|---|---|
| 4.1 | "About yourself" collapsible section | Display name, avatar, bio | done |
| 4.2 | Discovery: Show mature content (18+) | Same | done |
| 4.3 | Discovery: Hide AI-generated content | Not needed (see 1.10) | n/a |
| 4.4 | Locale: Country | Same | done |
| 4.5 | Locale: Interface language | Same | done |
| 4.6 | Locale: Preferred reading language ("Any language") | Same | done |
| 4.7 | Privacy: Show real name on profile | Same | done |
| 4.8 | Privacy: Show donation amounts | Same | done |
| 4.9 | Privacy: Allow direct messages | Same | done |
| 4.10 | Email: platform newsletter | Same | done |
| 4.11 | Email: Private conversations | Same | done |
| 4.12 | Email: New forum thread replies | Same | done |
| 4.13 | Email: New @mention | Same | done |
| 4.14 | Email: New comic releases | Same | done |
| 4.15 | Email: Weekly personal feed summary | Same | done |
| 4.16 | Email: New follower notifications | Same | done |
| 4.17 | Email: Weekly publishing analytics summaries | Same | done |
| 4.18 | Beta participation opt-in | Same | done |
| 4.19 | Change email (requires current password) | Same, plus confirmation link to the new address | done |
| 4.20 | Change password (current, new, confirm; min 6 chars) | Same, min 10 chars | done |
| 4.21 | Credits & promo codes: page-credit balance | Same | done |
| 4.22 | Claim promo / gift / credit code (e.g. ABCD-1234) | Same | done |
| 4.23 | Danger zone: delete account | Same | done |

## 5. Store

| # | Seen | NSFWComix | Better | Status |
|---|---|---|---|---|
| 5.1 | Hero carousel of wide promo banners with progress bar and dots | Admin-curated hero carousel | | done |
| 5.2 | "New Releases" row with Last week / Earlier tabs and View All | Same | | done |
| 5.3 | Cover cards with issue/chapter number badge | Same | Price / Free / Unlimited badge on the card | done |
| 5.4 | Sale callouts ("50% Off – Volumes …") | Publisher discounts surface as sale rows | | done |
| 5.5 | "Originals" section | Staff picks + spotlight rows | Indie titles are never buried under licensed catalogs: dedicated "Independent" rows | done |

## 6. Brand (publisher / creator) public profile

| # | Seen | NSFWComix | Status |
|---|---|---|---|
| 6.1 | Avatar, name, series count, bio | Same | done |
| 6.2 | "Search titles" within the brand | Same | done |
| 6.3 | Follow / Following | Same | done |
| 6.4 | Donate button | Tip button | done |
| 6.5 | Monthly goal progress bar ($0 of $100) | Same | done |
| 6.6 | Social links (Facebook, website) | Website, X, Facebook, Instagram, Bluesky, YouTube, Discord | done |
| 6.7 | Members list with role (Owner) | Same | done |
| 6.8 | Kebab menu (report/share) | Share + report | done |
| 6.9 | Back button | Same | done |

## 7. Studio: brand settings ("Page settings")

Sidebar groups seen: CONTENT (Identity, Promo Codes, Conventions β, Marketing β),
PDF DOWNLOAD SALES (Pricing β, Discounts β, Bundles β), REVENUE (Payout
Settings, Donation Settings, Revenue Splitting β, Payouts & Revenue), BILLING
(Subscriptions, Payment Methods, Order History), TEAM (Members, Roles).
Top tabs: SETTINGS, ANALYTICS, SERIES.

| # | Seen | NSFWComix | Better | Status |
|---|---|---|---|---|
| 7.1 | Identity: Brand name | Same | | done |
| 7.2 | Identity: Short bio (400 chars) | Same | | done |
| 7.3 | Identity: "Gold Membership Details" free text | Membership note shown on brand page | | done |
| 7.4 | Identity: Creator vs Publisher ("contact us to change") | Creator / Publisher | Self-serve switch request, approved in /admin | done |
| 7.5 | Identity: Country, Primary language, Timezone | Same | | done |
| 7.6 | Identity: Google Analytics tracking ID | Same | | done |
| 7.7 | Social: Website, Twitter username, Facebook page | See 6.6 | | done |
| 7.8 | Promo Codes | Unlock / discount codes, single or bulk | Bulk backer codes per reward tier with CSV import/export and emailing | done |
| 7.9 | Conventions (beta) | Convention appearances list on brand page | | done |
| 7.10 | Marketing (beta) | Announcement email to followers | | done |
| 7.11 | PDF sales: Pricing | Per-release download price + brand defaults | | done |
| 7.12 | PDF sales: Discounts | Timed percentage discounts | | done |
| 7.13 | PDF sales: Bundles | Multi-release bundles at one price | | done |
| 7.14 | Revenue: Payout settings | Payout method + details | | done |
| 7.15 | Revenue: Donation settings | Tips on/off, monthly goal | | done |
| 7.16 | Revenue: Revenue splitting (beta) | Per-series percentage splits to collaborators | Splits are paid automatically into each collaborator's own balance | done |
| 7.17 | Revenue: Payouts & revenue | Ledger, balance, payout requests | Every cent itemized; pending vs confirmed never differ silently | done |
| 7.17a | (not seen) | Tax information: year-to-date earnings against the tax reporting limit, and a form (US and non-US payees, typed signature) asked for once the limit is reached; payouts wait until it is on file | Name and country filled in from what is already on file; the taxpayer ID is stored encrypted and only its last 4 digits are ever shown again | done |
| 7.18 | Billing: Subscriptions, Payment methods, Order history | Not needed for creators | Publishing is free: no paid "Pro" tier to unlock a better share | n/a |
| 7.19 | Team: Members | Invite by email/username | | done |
| 7.20 | Team: Roles | Owner, Admin, Editor, Analyst | | done |

## 8. Studio: create series

| # | Seen | NSFWComix | Better | Status |
|---|---|---|---|---|
| 8.1 | Title | Same | | done |
| 8.2 | Language | Same | | done |
| 8.3 | Original publishing year | Same | | done |
| 8.4 | Status (Ongoing …) | Ongoing, Completed, Hiatus, Canceled | | done |
| 8.5 | Type: Comic, Graphic Novel, Manga, WebComic | Same | | done |
| 8.6 | Genre (single) | Same | | done |
| 8.7 | Theme (max 6) | Same | | done |
| 8.8 | Art style (max 2) | Same | | done |
| 8.9 | Audience (max 3) | Same | | done |
| 8.10 | Advisory flags | Same | | done |
| 8.11 | Page layout: Print layout / Vertical scroll | Same | | done |
| 8.12 | Reading direction LTR / RTL | Same | | done |
| 8.13 | Default access model: Free / Gold | Free / Premium | | done |
| 8.14 | Separate page afterwards to add cover; "MISSING COVER IMAGE!" and yellow warning; series hidden from lists until a cover exists | Cover upload in the create form | Cover defaults to page 1 of the first release, so a series is never invisible by accident | done |
| 8.15 | "Field default_release_type not found" error shown on the metadata tab | — | No raw field errors | n/a |

## 9. Studio: series editor

Tabs seen: METADATA, PAYWALL, ADVANCED, RELEASES. Advanced has its own
sidebar: CONTENT (Settings, Contributors, Languages), MONETIZATION (Settings,
Crowdfunding), COMMUNITY (Forums).

### 9a. Metadata

| # | Seen | NSFWComix | Better | Status |
|---|---|---|---|---|
| 9.1 | Title, Description (1800 chars) | Same | | done |
| 9.2 | Genre, Theme, Time/Era, Audience, Art style, Advisory flags | Same | | done |
| 9.3 | Tags (comma separated) | Tag chips | | done |
| 9.4 | Allow comments | Same | | done |
| 9.5 | Update frequency | Same | | done |
| 9.6 | Per-language metadata ("English Metadata"), language list with Add | Per-language title/description | | done |
| 9.7 | "Expand shared language series settings" | Shared settings shown inline | | done |
| 9.8 | Releases metadata table: Release #, Copy URL, cover, title, pages, type, Seq #, ISBN, orig pub date, NSFW, audiences, themes, content ratings, contributors (+Add), publish dot + Publish, Save, Files | Same bulk table | One Save for the whole table instead of per row | done |

### 9b. Paywall

| # | Seen | NSFWComix | Better | Status |
|---|---|---|---|---|
| 9.9 | Revenue share statement ("subscription 70%, à-la-carte 70%") | Share statement with live numbers | Higher share, and no paid plan needed to get it | done |
| 9.10 | Public access: Blocked / Free / Gold | Blocked / Free / Premium | | done |
| 9.11 | Paywall expires + expiration days (90) | Same | | done |
| 9.12 | Free preview model: First 3 releases; First and last 3 releases; First 10 pages of each release; Custom first x; Custom first and last releases; Automatic (experimental) | All six | "Automatic" is explained: first release free plus first N pages of the rest | done |
| 9.13 | Country-specific rules (country, rule, enabled; add new) | Per-country allow / block / free / premium | | done |
| 9.14 | Release prices table: Force free (Always), Free to read date (Set; batch edit in Publish), PDF price (Not for sale …), PDF discount, publishing status, Save, Files | Same table | Read-online price and download price are separate columns | done |

### 9c. Advanced

| # | Seen | NSFWComix | Status |
|---|---|---|---|
| 9.15 | Type, Page layout, Primary language | Same | done |
| 9.16 | Official website | Same | done |
| 9.17 | Original publishing year, Status | Same | done |
| 9.18 | Reading direction | Same | done |
| 9.19 | Display in public lists (unlisted but reachable by link) | Visibility: Draft / Public / Unlisted | done |
| 9.20 | Read Now button widget: color, size, iframe embed code | Same, plus cover-card embed | done |
| 9.21 | Contributors (people + roles) | Same | done |
| 9.22 | Languages (add a translated edition) | Same | done |
| 9.23 | Monetization settings (duplicate of Paywall) | Single Paywall tab | n/a |
| 9.24 | Crowdfunding: display banner toggle, service (Kickstarter …), funding goal, campaign link, timezone, start date/time, end date/time, countdown | Same | Works with IndieCrowdfund, Kickstarter, Indiegogo, BackerKit, Zoop; banner shown inside the reader's last page too | done |
| 9.25 | Forums: enable, description (400), moderators by username, owner row with date added | Same | done |

### 9d. Releases tab

| # | Seen | NSFWComix | Better | Status |
|---|---|---|---|---|
| 9.26 | Grid / list toggle | Same | | done |
| 9.27 | Language selector + "Add new" | Same | | done |
| 9.28 | "Create new release" tile | Same | Drop files on the tile to create the release and upload in one step | done |
| 9.29 | Release card: cover, Free badge, #, "P2P" tag, Draft, group (Singles), "Issue 1", title, page count | Same | | done |
| 9.30 | Create-release dialog: title, NSFW ("think twice before sharing with a parent or boss?"), release type | Same | Title and number are pre-filled from the series | done |
| 9.31 | Release types grouped: Singles (Issue, Omake, Special), Verticals (Episode), One-shots (One-shot), Volumes (Graphic Novel, Bandes Dessinée, Volume), Omnibuses (Omnibus), Compendiums (Compendium); each with its own sequence | Same groups and types | | done |

## 10. Studio: release editor

| # | Seen | NSFWComix | Better | Status |
|---|---|---|---|---|
| 10.1 | Breadcrumb brand › series › "Release #1 (English)" | Same | | done |
| 10.2 | "Go to release", "View stats" links | Same | | done |
| 10.3 | Release title; chapter synopsis (1800) | Same | | done |
| 10.4 | Not safe for work | Same | | done |
| 10.5 | Double-page grouping logic ("Prefer last 2 pages") | Same | | done |
| 10.6 | Force single-page cover | Same | | done |
| 10.7 | Contributors selector + "add a new contributor" | Same | | done |
| 10.8 | ISBN (10 or 13) | Same, validated | | done |
| 10.9 | Print edition URL | Same | Shown as "Buy in print" in the reader and on the series page. A Creator Premium feature (14.1c): only a brand with Premium can add or change the link; a saved link is kept but hidden from readers while the brand has no Premium | done |
| 10.10 | Original published date | Same | | done |
| 10.11 | Upload drop zone: PNG, JPG, ZIP, CBZ, PDF; "File requirements" link | Same plus WebP and CBR-free CBZ | | done |
| 10.12 | Processing bar ("Waiting for server…", "19 / 32 pages processed") | Live progress | | done |
| 10.13 | Page grid: thumbnail, checkbox, #n, Edit, View, gear | Same | Drag to reorder; multi-select bulk free/delete | done |
| 10.14 | "Missing Frames" badge on every page until done by hand | Frame status badge | **One click detects frames for the whole release** | done |
| 10.15 | Double-page pair badges (D-7, D-8 … alternating colors) | Spread pairing badges | | done |
| 10.16 | "Free" badge on page thumbnails | Free / Locked badge | | done |
| 10.17 | Page settings dialog: preview; filename, size, created, status; View Original / Desktop CDN / Mobile CDN / Thumbnail CDN; width, height, DPI; "Always free to read"; Set as series cover; Set as release cover; Save / Cancel / Delete | Same | | done |
| 10.18 | Publishing status: Share privately (Copy private URL), status dot, date, Preview, Schedule & Publish | Same | | done |
| 10.19 | Delete release | Same (soft delete) | | done |
| 10.20 | Download original pages | Same | | done |
| 10.21 | Related archive files: original uploaded archive, Extract, date and size | Same | | done |

## 11. Studio: page / frame editor

| # | Seen | NSFWComix | Better | Status |
|---|---|---|---|---|
| 11.1 | Page pager: first, prev, "n of N", next, last | Same + arrow keys | | done |
| 11.2 | Zoom out, reset, zoom in, fullscreen | Same + wheel zoom | | partial |
| 11.3 | Left panel tabs: Text, Frames | Same | | done |
| 11.4 | Background color per page (#000000) | Same | Auto-sampled from the page edge | done |
| 11.5 | Frame list ("Frame 1", drag handle, delete) | Same, drag to reorder | | done |
| 11.6 | "AI-Suggested Frames — SHOW" | "Detect frames" | Image analysis of gutters; nothing leaves the server | done |
| 11.7 | Tool: Select | Same (V) | | done |
| 11.8 | Tool: Grab / pan (H) | Same | | done |
| 11.9 | Tool: Create frame by clicking vertices (P) | Polygon tool | | done |
| 11.10 | Tool: Rectangle frame (F) | Same | | done |
| 11.11 | Tool: Smart frame (S) — click a region, it fills | Smart frame: click inside a panel and it snaps to the panel border | | done |
| 11.12 | Tool: Add object mode (D) — extend the frame | Same | | done |
| 11.13 | Tool: Remove object mode (R) — cut from the frame | Same | | done |
| 11.14 | Delete selected | Same (Del) | | done |
| 11.15 | Accept / Cancel while drawing | Same (Enter / Esc) | Undo / redo | done |
| 11.16 | Numbered badges on frames, hint bar ("Click each vertex…") | Same | | done |
| 11.17 | Preview (guided view) and Publish buttons | Same | | done |
| 11.18 | Text tab (text regions for translation) | Text regions with transcription per language | | done |

## 12. Studio: analytics

| # | Seen | NSFWComix | Better | Status |
|---|---|---|---|---|
| 12.1 | Dashboard, last 30 days vs previous 30 | Same, selectable range | | done |
| 12.2 | Readers: Unique readers, Total visits, Page reads with deltas | Same | | done |
| 12.3 | Revenue: Donations, Content, Downloads + à-la-carte, Total | Same | Shows how the subscription figure was calculated | done |
| 12.4 | Engagement: Followers, Favorites, Forum posts, Comments | Same | | done |
| 12.5 | Notifications: Emails sent, opened, clicked | Same | | done |
| 12.6 | Sub-pages: Page reads, Releases, Revenue, Followers, Favorites, Forums, Comments, Email | Same | Per-page drop-off chart per release; reader countries; CSV export | done |

## 13. Reader-side features implied by the screenshots

| # | Seen / implied | NSFWComix | Status |
|---|---|---|---|
| 13.1 | Library | Continue reading, owned, following, favorites | done |
| 13.2 | Downloads shelf (`/my-shelf/downloads`) | Purchased downloads | done |
| 13.3 | Membership page | Plan, renewal date, cancel | done |
| 13.4 | Purchases | Order history with receipts | done |
| 13.5 | Gift cards | Buy and redeem | done |
| 13.6 | Page credits (pay per page) | Page credits | done |
| 13.7 | Favorites and followers | Same | done |
| 13.8 | Comments on comics | Same | done |
| 13.9 | Forums (site-wide and per title) | Same | done |
| 13.10 | News | News posts from /admin | done |
| 13.11 | Creators directory | Same | done |
| 13.12 | Community | Activity feed | done |
| 13.13 | Reader modes: single, double-page, vertical, guided frames | All four | done |
| 13.14 | Submit feedback | Same | done |

## 14. Platform (not in the screenshots, required)

| # | NSFWComix | Status |
|---|---|---|
| 14.1 | `/admin` panel: dashboard, users, brands, series moderation, orders, memberships, payouts, settlement, codes, featured rows, announcements, pages, news, feedback, reports, audit log | done |
| 14.1a | Creator taxes in `/admin`: limit and on/off switch in Settings > Revenue; per-year list of brands with earnings, over-the-limit and form status, filters, CSV export for the accountant (full taxpayer IDs only for a super admin who ticks and confirms), audited one-time reveal of an ID, "needs update" request to a brand. The site collects and exports; it does not file with the IRS or produce the IRS form | done |
| 14.1b | Sales tax at checkout (off by default): the owner sets a rate per US state under Settings > Sales tax; checkout, the reader paywall, page-credit packs and membership start ask for country, state and ZIP code and show "Subtotal", "Sales tax (State N%)" and "Total"; tax is charged on comics, bundles, page credits and memberships (first payment and renewals), not on tips or gift cards, and never enters creator earnings; receipts, order history and emails show the tax line; refunds return it; Finance > Sales tax reports taxable sales, tax collected, refunded and net by state for a date range, with CSV export. The site collects and reports; it does not file returns | done (tested against a stand-in processor only) |
| 14.1c | Creator Premium: an optional yearly plan per brand (140.00 a year by default; price in Settings > Creator Premium), annual only, renewing on a saved card until canceled, no trial; canceling keeps it to the end of the paid year. Sales tax is added like on the reader membership. It gates exactly two things for the whole brand team: the "Buy in print" link (add/change; saved links hidden from readers without Premium) and advanced analytics (drop-off, countries, followers, engagement, email statistics and every CSV export; overview, earnings and page reads stay free), enforced on the server with `premium_required`. Studio > Creator Premium: what it includes, price, subscribe through the embedded secure checkout, status, cancel/resume, change card, payments with tax; owners and admins manage it, the rest of the team sees the status. Admin > Finance > Creator Premium: brands, totals, payments, full refund, and granting it to any brand without payment (end date or none, optional note; also on the brand page). The money is platform revenue only: separate tables, never in the membership pool, the creator ledger or the membership figures | done (tested against the sandbox and a stand-in processor only) |
| 14.2 | Integrations editable in `/admin`: Cloudflare R2 storage, SendGrid email, payments, reCAPTCHA, analytics | partial |
| 14.3 | Email: templates, queue, log, suppression list, unsubscribe | done |
| 14.3a | Inbound mail: admin mailboxes (support@, dmca@ ...) fed by SendGrid Inbound Parse, read and answered in /admin/inbox, blocked senders, optional automatic reply | done (not yet tried against live SendGrid delivery) |
| 14.4 | Bot blocker ported from IndieCrowdfund | done |
| 14.5 | Membership plus direct sales, with per-reader split of membership money | partial |
