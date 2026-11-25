-- Privacy pages: standard wording replaces the two owner placeholders
-- (analytics opt-out, and how long data is kept).
update cms_pages
   set body = replace(body,
     '*[Owner: if analytics is enabled, describe it here and how to opt out.]*',
     'We may also use an analytics service to count visits and see which pages are used, so we can improve the site. It is not used for advertising. To opt out, email [support@nsfwcomix.com](mailto:support@nsfwcomix.com) from the address on your account and we will exclude you.');

update cms_pages
   set body = replace(body,
     '*[Owner: confirm the retention periods that apply to you.]*',
     'When you delete your account, we delete or anonymize your account data within 30 days. Purchase, payout and tax records are kept for seven years. Security and access logs are kept for up to 12 months. Backups are overwritten within 90 days.');
