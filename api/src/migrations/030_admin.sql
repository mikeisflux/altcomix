-- Admin / operations: cancellable queued email, first drafts of the footer pages.

alter table emails drop constraint emails_status_check;
alter table emails add constraint emails_status_check
  check (status in ('queued','sending','sent','failed','suppressed','cancelled'));

create index if not exists login_events_created_idx on login_events (created_at desc);
create index if not exists audit_log_action_idx on audit_log (action, created_at desc);
create index if not exists audit_log_target_idx on audit_log (target_kind, target_id);

-- First drafts of the footer pages, in Markdown. They are starting points for
-- the owner to review and rewrite in /admin > Pages, not legal advice. Rows
-- that already exist are left alone.
insert into cms_pages (slug, title, body) values
('about', 'About NSFWComix', $md$
**Draft.** This page is a first draft written during setup. Review and edit it in Admin > Pages before launch.

## Comics, straight from the people who make them

NSFWComix is a place to read and publish comics, graphic novels, manga and webcomics. Creators upload their own work, set their own prices and keep most of what readers pay.

## How it works for readers

- Read free previews of every premium series before you spend anything.
- Buy single releases to own them, or join the membership to read everything in the membership catalogue.
- Follow series and creators to hear when something new is out.

## How it works for creators

- Publish under your own brand page, alone or with a team.
- Choose what is free, what is paid and what is in the membership catalogue.
- See what you earned and where it came from, and request a payout when you are ready.

## No generative AI

NSFWComix does not accept AI-generated comics. Everything here is made by people.

## Get in touch

See the [contact page](/p/contact).
$md$),
('contact', 'Contact us', $md$
**Draft.** This page is a first draft written during setup. The owner needs to add real contact details in Admin > Pages before launch.

## Help with your account or a purchase

Use the **Feedback** link in the site menu. Tell us which account and which order the question is about and we will reply by email.

## Creators and publishers

Questions about publishing, payouts or your brand page: use the Feedback link and choose the category that fits best.

## Reporting content

Every series, release, comment and profile has a **Report** option. That is the fastest way to reach the moderation team. See the [content policy](/p/content-policy) for what is and is not allowed.

## Copyright complaints

If you believe something on NSFWComix infringes your copyright, send us: the work you own, where it appears on NSFWComix, your contact details, and a statement that you are the rights holder or act for them.

*[Owner: add the support email address, a postal address if you are required to publish one, and the address that receives copyright notices.]*
$md$),
('content-policy', 'Content policy', $md$
**Draft.** This page is a first draft written during setup, not legal advice. Review it, and have it checked if you can, before launch.

## What belongs on NSFWComix

Comics, graphic novels, manga and webcomics that you made or have the right to publish.

## What is not allowed

- **Work you do not have the rights to.** Scans of other people's books, unlicensed translations, and fan work that the rights holder has objected to.
- **AI-generated comics.** Art or writing produced by generative AI is not accepted. Tools that assist a human artist (lettering, flatting helpers, colour correction) are fine.
- **Sexual content involving minors**, or characters presented as minors, in any form. This is removed and reported where the law requires.
- **Content that promotes hatred or violence** against people because of who they are.
- **Harassment** of real people, including publishing private information about them.
- **Illegal content**, and content whose main purpose is to deceive or defraud readers.

## Mature content

Stories for adults are welcome when they are labelled. Mark a series or release as **mature** if it contains explicit sexual content, graphic violence or similar material, and use the content advisories. Mature work is hidden from readers who have not opted in. Moderators may add the mature label when it is missing.

## Comments and community

Be civil. Criticise the work, not the person. Spam, slurs and harassment are removed.

## Reporting and enforcement

Use the **Report** option on any series, release, comment or profile. Moderators review reports and may hide a comment, add a mature label, take a series down, or suspend an account or brand. When we take a series down we tell the brand owner the reason.

## Appeals

If you think a decision was wrong, reply to the notice you received or contact us through the [contact page](/p/contact).
$md$),
('publisher-sla', 'Publisher service commitments', $md$
**Draft.** This page is a first draft written during setup, not a binding commitment until the owner has reviewed it. Every figure below is a placeholder to confirm or change.

## What this page is

What creators and publishers can expect from NSFWComix as a service. It sits alongside the [publisher terms](/p/publisher-terms).

## Availability

We aim to keep the store, the reader and Studio available around the clock. Planned maintenance is announced on the site in advance where possible.

*[Owner: decide whether to state an uptime target. Do not publish a number you are not measuring.]*

## Your files

- Original page files you upload are kept so that we can re-process them.
- You can replace or delete your releases at any time from Studio.

## Earnings and payouts

- Sales and tips appear in your ledger when the payment is confirmed.
- Membership earnings are calculated after each month ends.
- Earnings become available for payout after a holding period, and payouts can be requested once the balance reaches the minimum. Both values are shown in Studio.
- *[Owner: state how long a payout request normally takes to review and send.]*

## Support

*[Owner: state the support channel and the response time you can actually meet.]*

## Moderation

If we take action on your content we tell you what was done and why, and how to appeal. See the [content policy](/p/content-policy).
$md$),
('privacy', 'Privacy policy', $md$
**Draft.** This page is a first draft written during setup. It is not legal advice and has not been reviewed by a lawyer. The owner must complete the bracketed parts and have it checked before launch.

## Who we are

NSFWComix is operated by *[Owner: legal name and address of the operator]*. Contact: see the [contact page](/p/contact).

## What we collect

- **Account details:** email address, username, display name, and a password stored only as a salted hash.
- **Profile content you add:** avatar, bio, and the comics and brand pages you publish.
- **Reading and purchase activity:** what you read, follow, buy and redeem. This drives your library, creator analytics and the split of membership money between creators.
- **Payment records:** what was bought and for how much. Card details are entered on our payment processor's pages and are never stored on NSFWComix.
- **Technical data:** IP address, browser type and session cookies, used to keep you signed in and to protect the site from abuse.
- **Messages:** feedback, reports and direct messages you send through the site.

## How we use it

To run your account, deliver what you bought, pay creators, send service emails (receipts, security notices), send notifications you have chosen to receive, prevent fraud and abuse, and understand how the site is used.

## Who we share it with

- **Creators** see aggregated statistics about their readers, not your identity, unless you interact with them publicly (comments, tips with a message).
- **Service providers** that host files, send email and process payments, only as needed to provide those services.
- **Authorities**, when the law requires it.

We do not sell personal data.

## Cookies

We use cookies that are necessary to sign you in and protect forms. If analytics is enabled, it is listed on the [privacy choices](/p/privacy-choices) page.

## How long we keep it

Account data is kept while the account exists. Purchase and payout records are kept as long as accounting rules require. Security logs are kept for a limited period.

*[Owner: confirm the retention periods that apply to you.]*

## Your rights

Depending on where you live you may have the right to see, correct, export or delete your data, and to object to some uses. To make a request, use the [contact page](/p/contact).

## Children

NSFWComix is not intended for children under the age at which they can consent to data processing in their country. *[Owner: confirm the minimum age.]*

## Changes

We will update this page when our practices change and note the date here.
$md$),
('privacy-choices', 'Your privacy choices', $md$
**Draft.** This page is a first draft written during setup. Review it in Admin > Pages before launch.

## Email

- **Notifications and newsletters:** turn each kind on or off in your account settings, or use the unsubscribe link at the bottom of any of those emails.
- **Service emails** such as receipts, password resets and security notices are part of running your account and cannot be turned off.

## Cookies

NSFWComix sets the cookies needed to sign you in and to protect forms from forged requests. These are required for the site to work.

*[Owner: if analytics is enabled, describe it here and how to opt out.]*

## Mature content

Mature series are hidden unless you choose to see them in your account settings.

## Selling or sharing of personal data

We do not sell personal data, and we do not share it for cross-site advertising.

## Access, export and deletion

You can ask for a copy of your data or for your account to be deleted through the [contact page](/p/contact). Some records, such as purchases and payouts, must be kept for accounting.

See the full [privacy policy](/p/privacy).
$md$),
('terms', 'Terms of service', $md$
**Draft.** This page is a first draft written during setup. It is not legal advice and has not been reviewed by a lawyer. The owner must complete the bracketed parts and have it checked before launch.

## 1. Agreement

By using NSFWComix you agree to these terms. NSFWComix is operated by *[Owner: legal name of the operator]*.

## 2. Your account

You are responsible for your account and for keeping your password safe. Give accurate information. One person, one account, unless we agree otherwise. *[Owner: state the minimum age.]*

## 3. Reading and buying

- When you buy a release you get a personal, non-transferable licence to read it on NSFWComix for as long as the service offers it. Where a download is included, the file is for your personal use.
- Membership gives access to the membership catalogue while your membership is active. The catalogue can change.
- Prices are shown before you pay. *[Owner: state how taxes are handled.]*

## 4. Refunds

*[Owner: state your refund policy, including any legal right to withdraw that applies to your customers.]*

## 5. Membership renewal and cancellation

Membership renews automatically at the end of each period until you cancel. You can cancel at any time in your account settings; access continues until the end of the period you paid for.

## 6. Codes, gift cards and credits

Codes and gift cards have no cash value, cannot be resold, and may expire where the code says so.

## 7. Acceptable use

Do not copy, redistribute or scrape comics from NSFWComix, attempt to bypass the paywall, harass other people, or interfere with the service. The [content policy](/p/content-policy) applies to everything you post.

## 8. Creators

If you publish on NSFWComix the [publisher terms](/p/publisher-terms) also apply.

## 9. Ending accounts

You can close your account at any time. We may suspend or close accounts that break these terms.

## 10. Liability

*[Owner: add the warranty disclaimer and limitation of liability appropriate to your jurisdiction.]*

## 11. Governing law

*[Owner: state the governing law and courts.]*

## 12. Changes

We may update these terms. If a change is significant we will tell you by email or on the site before it takes effect.
$md$),
('publisher-terms', 'Publisher terms', $md$
**Draft.** This page is a first draft written during setup. It is not legal advice and has not been reviewed by a lawyer. The owner must complete the bracketed parts and have it checked before launch. Percentages are not stated here on purpose: the current figures are shown in Studio.

## 1. Who this applies to

Anyone who publishes on NSFWComix through a brand page, whether a solo creator or a publisher. These terms add to the [terms of service](/p/terms).

## 2. Your work stays yours

You keep all rights to what you publish. You give NSFWComix a non-exclusive licence to host, display, and deliver your work to readers on the service, and to show covers and short previews to promote it on NSFWComix. The licence ends when you remove the work, except that readers who bought a release keep access to it.

## 3. What you promise

- You own the work or have the rights needed to publish and sell it here, including for every contributor.
- It was not made with generative AI.
- It follows the [content policy](/p/content-policy), and mature work is labelled.

## 4. Pricing and access

You decide what is free, what is sold and at what price, and whether a series is in the membership catalogue. You can change this at any time; changes do not affect purchases already made.

## 5. Earnings

- **Sales and tips:** you receive your share of each payment after payment processing costs.
- **Membership:** each member's payment for a month is divided among the brands that member read that month, in proportion to pages read, and you receive your share of your part.
- The share percentages that apply to your brand are shown in Studio. *[Owner: decide how much notice you give before changing them.]*
- **Revenue splits** you set up between collaborators are applied automatically.

## 6. Payouts

Earnings become available after a holding period. You can request a payout once your available balance reaches the minimum shown in Studio. You are responsible for the accuracy of your payout details and for your own taxes. *[Owner: state any tax forms or identity checks you require.]*

## 7. Refunds and chargebacks

If a sale is refunded or reversed, the earnings from it are reversed in your ledger.

## 8. Codes

Codes you generate for backers or promotions grant access as described when you create them.

## 9. Removal

You may remove your work at any time. We may take down work or suspend a brand that breaks these terms or the content policy, and we will tell you why.

## 10. Liability

*[Owner: add the indemnity and limitation of liability appropriate to your jurisdiction.]*
$md$),
('faq', 'Frequently asked questions', $md$
**Draft.** This page is a first draft written during setup. Review it in Admin > Pages before launch.

## Reading

**Is anything free?**
Yes. Free series can be read in full, and every premium series has a free preview.

**What does membership include?**
Every series that its creator has placed in the membership catalogue, for as long as your membership is active.

**What is the difference between buying and membership?**
A release you buy stays in your library. Membership gives access to the catalogue only while you are a member.

**What are page credits?**
Credits unlock single pages of premium comics without buying the whole release.

**I have a code. Where do I enter it?**
Open **Redeem** from the account menu.

**Can I read on my phone?**
Yes. The reader works in any modern browser and can be installed to your home screen.

## Account

**I did not get the confirmation email.**
Check your spam folder, then use **Resend** in your account settings.

**How do I cancel my membership?**
In your account settings. You keep access until the end of the period you paid for.

**How do I delete my account?**
Ask through the [contact page](/p/contact).

## Creators

**Who can publish?**
Anyone who makes comics and owns the rights to them. Press **Publish** to open Studio.

**Do you accept AI-generated comics?**
No.

**How do I get paid?**
Earnings from sales, tips and membership reading appear in Studio. Request a payout once your available balance reaches the minimum shown there.

**Can I give copies to crowdfunding backers?**
Yes. Generate unlock codes in Studio and send them to your backers.
$md$)
on conflict (slug) do nothing;

update cms_pages set body = btrim(body, E'\n') where updated_by is null;
