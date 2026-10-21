-- 0032_payg_payment_failed_notice.sql — the customer is told, durably, when a pay-as-you-go invoice fails
--
-- A failed settlement invoice revokes the customer's key and blocks minting (lib/payg-billing.ts). They used to learn of it only from
-- Stripe's own emails, a dashboard setting this site cannot verify. The notice is an obligation in the existing durable outbox (0021):
-- kind payg_payment_failed, subject = the settlement row, one per failed settlement (the outbox's unique dedupe key), rebuilt from the
-- current settlement and account at send time and cancelled unsent if the invoice has been paid since.
--
-- Additive and idempotent. Re-states the two checks 0028 / 0027 last set, plus the new kind and subject table.

alter table public.customer_notifications drop constraint if exists customer_notifications_kind_check;
alter table public.customer_notifications add constraint customer_notifications_kind_check
  check (kind in ('intake_link', 'api_access_link', 'watch_link', 'key_rotation', 'subscription_welcome', 'team_invitation', 'usage_alert', 'payg_payment_failed'));

alter table public.customer_notifications drop constraint if exists customer_notifications_subject_table_check;
alter table public.customer_notifications add constraint customer_notifications_subject_table_check
  check (subject_table in ('deliverables', 'api_accounts', 'watches', 'subscriptions', 'subscription_invitations', 'usage_settlements'));
