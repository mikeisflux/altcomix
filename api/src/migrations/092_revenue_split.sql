-- Revenue split set by the owner. Creators get 93.5% of direct sales and 80% of membership
-- fees, as a percentage of what the reader paid; the payment processor keeps 3.5%; the
-- platform keeps the rest (3% of sales, 16.5% of membership). Saved settings are updated to
-- match. Per-brand share overrides and the tips share are left as they are.
update settings
   set value = value || '{"sale_share_bps": 9350, "sub_share_bps": 8000, "fee_pct_bps": 350, "fee_fixed_cents": 0}'::jsonb
 where key = 'revenue' and jsonb_typeof(value) = 'object';

update cms_pages
   set body = replace(body,
     '- **Sales and tips:** you receive your share of each payment after payment processing costs.',
     '- **Sales and tips:** you receive your share of the price the reader paid. The payment processor''s fee and the platform''s part come out of the rest.');
