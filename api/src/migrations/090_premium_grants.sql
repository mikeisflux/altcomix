-- Creator Premium: a complimentary grant and a paid plan can run side by side
-- (the brand has Premium while either is active), so "one running plan per
-- brand" becomes one running paid plan and one running grant per brand.
-- A grant with no end date is stored with current_period_end = 9999-12-31.
drop index premium_subscriptions_live_key;
create unique index premium_subscriptions_live_paid_key on premium_subscriptions (publisher_id) where status in ('active','past_due') and provider <> 'comp';
create unique index premium_subscriptions_live_grant_key on premium_subscriptions (publisher_id) where status in ('active','past_due') and provider = 'comp';
