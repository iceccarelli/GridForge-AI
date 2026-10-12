-- 0021_customer_notifications.sql — a customer's access email is a recoverable obligation, not a log line
--
-- The Stripe webhook records a purchase once (unique session / subscription) and then answered 200,
-- while the email carrying the buyer's only access link (Density Screen intake, API-access portal,
-- Hall Watch) was a best-effort side effect with no record of its own. A provider outage on the first
-- delivery left a paying customer with no link, and every Stripe retry saw "already fulfilled" and
-- skipped the email: nothing durable said it still had to happen.
--
-- This table is that record. One row per obligation (dedupe_key is unique), written by the webhook
-- from the business record's id. It stores NO recipient, token or message body: the message is rebuilt
-- from the business row at send time, so a capability link never has to be read out of a log or a copy.
--
--   pending   -> accepted    the mail provider ACCEPTED the message (not: the inbox received it)
--   pending   -> ambiguous   an attempt's outcome is unknown and can no longer be retried safely (the provider
--                            may have accepted it, but its 24 h idempotency window has passed): a person decides
--   pending   -> abandoned   attempts exhausted, or a permanent refusal; an operator must act
--   pending   -> cancelled   the obligation no longer applies (key already rotated, subscription superseded, ...)
--   abandoned / ambiguous -> pending   only by an explicit operator action (reopened_count records it)
--
-- Attempts are bounded (max_attempts) and leased (claimed_until) so concurrent runs cannot double-send.
-- Additive and idempotent. The application degrades to a direct, logged, best-effort send when this
-- table is absent, so it can be deployed before or after the migration.

create table if not exists public.customer_notifications (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique check (length(btrim(dedupe_key)) > 0),
  kind text not null check (kind in ('intake_link', 'api_access_link', 'watch_link', 'key_rotation', 'subscription_welcome')),
  subject_table text not null check (subject_table in ('deliverables', 'api_accounts', 'watches', 'subscriptions')),
  subject_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'ambiguous', 'abandoned', 'cancelled')),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 6 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  claimed_until timestamptz,
  last_attempt_at timestamptz,
  -- A category (not_configured, no_recipient, rejected, timeout, unreachable, ...), never a provider body.
  last_error text,
  last_http_status int,
  provider_message_id text,
  accepted_at timestamptz,
  -- Who asked for this row: the webhook, or an operator's explicit reconciliation of a pre-outbox purchase.
  origin text not null default 'webhook' check (origin in ('webhook', 'operator_reconcile')),
  reopened_count int not null default 0 check (reopened_count >= 0),
  created_at timestamptz not null default now(),
  check ((status = 'accepted') = (accepted_at is not null))
);

create index if not exists customer_notifications_due_idx
  on public.customer_notifications (status, next_attempt_at);

-- What was asked for never changes, and an accepted notification never goes back.
create or replace function public.gf_notification_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'customer_notifications rows are never deleted';
  end if;
  if new.dedupe_key is distinct from old.dedupe_key or new.kind is distinct from old.kind
     or new.subject_table is distinct from old.subject_table or new.subject_id is distinct from old.subject_id then
    raise exception 'a notification''s identity cannot change';
  end if;
  if old.status in ('accepted', 'cancelled') and new.status is distinct from old.status then
    raise exception 'an accepted notification cannot be reopened';
  end if;
  if new.origin is distinct from old.origin then
    raise exception 'a notification''s identity cannot change';
  end if;
  return new;
end
$$;

drop trigger if exists customer_notifications_guard on public.customer_notifications;
create trigger customer_notifications_guard before update or delete on public.customer_notifications
  for each row execute function public.gf_notification_guard();

alter table public.customer_notifications enable row level security;
revoke all on public.customer_notifications from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.customer_notifications from %I', r);
      execute format('revoke all on function public.gf_notification_guard() from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.customer_notifications to service_role;
    grant execute on function public.gf_notification_guard() to service_role;
  end if;
end
$$;
revoke all on function public.gf_notification_guard() from public;
