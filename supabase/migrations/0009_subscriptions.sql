-- 0009_subscriptions.sql — GridForge Intelligence subscriptions
--
-- This table was read and written by shipping code for several patches and never
-- existed. app/api/stripe/webhook wrote a row on checkout.session.completed,
-- app/api/subscription-status read it to decide whether /account shows the paid
-- view, and app/api/scenarios gated every read and write on it. PostgREST answers
-- a missing table with 404, `fetch` does not throw on 404, and every one of those
-- call sites wrapped the request in a `catch` — so the write failed in total
-- silence and the reads all resolved to "not subscribed".
--
-- The commercial consequence: a customer paid a real monthly subscription in
-- Stripe, nothing was recorded, and /account showed them the unsubscribed view
-- forever. Money in, nothing out, and no log line anywhere saying so.
--
-- stripe_subscription_id is the column that makes cancellation possible. The
-- webhook previously stored only the session and customer ids, so even with this
-- table present, customer.subscription.deleted had nothing to resolve against and
-- a cancelled subscription would have stayed active indefinitely — the same defect
-- that kept delivering a cancelled Hall Watch.
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  email text not null,
  plan text not null,                             -- developer | team | enterprise
  status text not null default 'active',          -- active | past_due | cancelled | superseded
  stripe_session_id text,
  stripe_customer_id text,
  stripe_subscription_id text
);

-- The hot path: "does this email have an active subscription right now".
create index if not exists subscriptions_email_status_idx
  on public.subscriptions (email, status);
-- The lifecycle path: resolve a Stripe event back to the row it belongs to.
create index if not exists subscriptions_sub_idx
  on public.subscriptions (stripe_subscription_id);
create index if not exists subscriptions_customer_idx
  on public.subscriptions (stripe_customer_id);

-- One active subscription per email. A second checkout supersedes the first
-- rather than silently doubling a customer's entitlement, and this makes that a
-- database invariant rather than an ordering assumption in the webhook.
create unique index if not exists subscriptions_one_active_per_email
  on public.subscriptions (email) where (status = 'active');

alter table public.subscriptions enable row level security;
-- No policies: the service role reaches it, nothing else. A subscriber only ever
-- touches this table through our own routes, which authenticate them first.
