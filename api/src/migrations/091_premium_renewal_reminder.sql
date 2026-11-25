-- Creator Premium: the period a renewal reminder was sent for, so each yearly
-- renewal gets exactly one reminder (sent 7 days before the charge).
alter table premium_subscriptions add column renewal_reminded_for timestamptz;
