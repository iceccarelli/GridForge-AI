-- 0011_one_fulfilment_per_payment.sql — a payment may be fulfilled exactly once
--
-- The Stripe webhook opened an engagement, an API account or a Hall Watch, and
-- when that write failed it logged a line, returned, and answered Stripe 200.
-- Stripe records a 200 as delivered and never retries, so a customer who had just
-- paid between EUR 4,500 and EUR 95,000 got no intake link, no engagement row, and
-- nothing in the admin dashboard. The money arrived; the product did not.
--
-- The handler now returns 500 on a failed write so Stripe redelivers. That fixes
-- the orphan and creates the opposite risk: a retry after a write that actually
-- succeeded — the insert landed, the response was lost — would fulfil the same
-- payment twice and hand one customer two tokens.
--
-- The handler checks for an existing row first. These indexes make that a
-- guarantee rather than a check that can lose a race with Stripe's own retry,
-- which can redeliver concurrently.
--
-- Partial, because the column is nullable and rows created by hand or by an older
-- flow legitimately have no Stripe id. Two such rows must not collide.
--
-- If one of these fails to create, it has found something worth knowing: two
-- fulfilments already exist for a single payment. Nothing is damaged — the
-- migration simply stops — and the duplicates want resolving before it is re-run.

create unique index if not exists deliverables_one_per_session
  on public.deliverables (stripe_session_id)
  where (stripe_session_id is not null);

create unique index if not exists watches_one_per_subscription
  on public.watches (stripe_subscription_id)
  where (stripe_subscription_id is not null);

create unique index if not exists api_accounts_one_per_subscription
  on public.api_accounts (stripe_subscription_id)
  where (stripe_subscription_id is not null);
