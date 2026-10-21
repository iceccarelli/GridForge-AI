-- 0034_deposit_receipt_notice.sql — the buyer of an Envelope Study / Portfolio Screen deposit is told, durably, what it states
--
-- A deposit opens no intake and no link, so the buyer's only confirmation was Stripe's receipt and the /commissioned page. The receipt
-- is an obligation in the existing durable outbox (0021): kind deposit_receipt, subject = the engagement_deposits row, one per deposit
-- (the outbox's unique dedupe key, so a Stripe redelivery is a no-op), rebuilt from the deposit row at send time. It carries what the
-- deposit reserves, what it opens, how it is credited, that no date is promised until scoping, who is recorded as the contact, the
-- reference to quote and what to prepare. It stores no recipient, token or body.
--
-- Additive and idempotent. Re-states the two checks 0032 last set, plus the new kind and subject table (numbered after 0033; the
-- pattern is the one 0032 follows).

alter table public.customer_notifications drop constraint if exists customer_notifications_kind_check;
alter table public.customer_notifications add constraint customer_notifications_kind_check
  check (kind in ('intake_link', 'api_access_link', 'watch_link', 'key_rotation', 'subscription_welcome', 'team_invitation', 'usage_alert', 'payg_payment_failed', 'deposit_receipt'));

alter table public.customer_notifications drop constraint if exists customer_notifications_subject_table_check;
alter table public.customer_notifications add constraint customer_notifications_subject_table_check
  check (subject_table in ('deliverables', 'api_accounts', 'watches', 'subscriptions', 'subscription_invitations', 'usage_settlements', 'engagement_deposits'));
