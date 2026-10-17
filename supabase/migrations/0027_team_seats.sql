-- 0027_team_seats.sql — GridForge Intelligence seats: who a subscription's owner has let in
--
-- lib/products.ts has declared INTELLIGENCE_PLANS[*].seats (developer 1, team 5, enterprise unlimited) since the plans
-- went on sale, and nothing enforced it: the number was a label. This makes it a database invariant.
--
-- The model reuses what is already here and adds only what is missing:
--
--   subscriptions               unchanged. Its `email` is the BILLING OWNER, who is always one seat.
--   subscription_invitations    an owner's offer of a seat to one email address. Only the SHA-256 of the link secret is
--                               stored; the secret itself is derived on the server (lib/team.ts) so the durable email
--                               outbox (0021) can rebuild the message without a token ever being copied into a queue.
--   subscription_members        who holds a seat besides the owner. Soft-removed (removed_at), never deleted.
--
-- Membership hangs off the OWNER'S EMAIL, not off a subscriptions row. A re-subscription (an upgrade) supersedes the old
-- row and inserts a new one (lib/subscribers.ts recordSubscription); keying seats to the row would silently strip a team
-- of its access on every upgrade. Keyed to the owner, a member follows whichever subscription of the owner currently
-- entitles ('active' or 'past_due' — the existing rule, unchanged). A cancelled or superseded-and-not-replaced
-- subscription therefore entitles nobody, owner or member, with no second bookkeeping step that could be forgotten.
--
-- Seat limits live HERE as well as in lib/products.ts because an invariant that only the application states is one a
-- second code path can break. tests/test_team_seats_migration.py fails if the two disagree.
--
-- Concurrency: every statement that can add a seat (invite, accept) first takes a row lock on the owner's entitling
-- subscription, so two racing for the last seat are serialised and the second sees the first. The webhook's supersede
-- UPDATE takes the same lock, so a seat cannot be granted against a row that is being replaced.
--
-- Nothing here prices anything, adds a product, or touches Stripe. Additive and idempotent.

-- ---------------------------------------------------------------------------
-- A. The plan's seat count. NULL = unlimited. An unrecognised plan is the owner alone: it fails closed.
-- ---------------------------------------------------------------------------
create or replace function public.gf_plan_seats(p_plan text) returns int
language sql immutable as $$
  select case p_plan
    when 'developer' then 1
    when 'team' then 5
    when 'enterprise' then null
    else 1
  end
$$;

-- ---------------------------------------------------------------------------
-- B. Invitations
-- ---------------------------------------------------------------------------
create table if not exists public.subscription_invitations (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null check (owner_email = lower(btrim(owner_email)) and position('@' in owner_email) > 1),
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1 and length(email) <= 254),
  -- SHA-256 hex of the secret in the link. The secret is never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'declined', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  declined_at timestamptz,
  check (email <> owner_email),
  check (expires_at > created_at),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((status = 'revoked') = (revoked_at is not null)),
  check ((status = 'declined') = (declined_at is not null))
);

-- One open offer per (owner, address). A second invitation to the same person has to retire the first.
create unique index if not exists subscription_invitations_one_pending
  on public.subscription_invitations (owner_email, email) where (status = 'pending');
create index if not exists subscription_invitations_owner_idx
  on public.subscription_invitations (owner_email, status);

-- ---------------------------------------------------------------------------
-- C. Members (the owner is implicit: subscriptions.email)
-- ---------------------------------------------------------------------------
create table if not exists public.subscription_members (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null check (owner_email = lower(btrim(owner_email)) and position('@' in owner_email) > 1),
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1),
  invitation_id uuid references public.subscription_invitations (id),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  check (email <> owner_email)
);

create unique index if not exists subscription_members_one_active
  on public.subscription_members (owner_email, email) where (removed_at is null);
-- The hot path: "is this address a member of anybody", on every protected request from a non-owner.
create index if not exists subscription_members_email_idx
  on public.subscription_members (email) where (removed_at is null);

-- ---------------------------------------------------------------------------
-- D. What cannot change, whatever calls the database
-- ---------------------------------------------------------------------------
create or replace function public.gf_invitation_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'subscription_invitations rows are never deleted';
  end if;
  if new.owner_email is distinct from old.owner_email or new.email is distinct from old.email
     or new.token_hash is distinct from old.token_hash or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'an invitation''s identity cannot change';
  end if;
  -- Single use: once an invitation has left 'pending' it never comes back.
  if old.status <> 'pending' and new.status is distinct from old.status then
    raise exception 'an invitation that is % cannot be reopened', old.status;
  end if;
  return new;
end
$$;

drop trigger if exists subscription_invitations_guard on public.subscription_invitations;
create trigger subscription_invitations_guard before update or delete on public.subscription_invitations
  for each row execute function public.gf_invitation_guard();

create or replace function public.gf_member_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'subscription_members rows are never deleted; set removed_at';
  end if;
  if new.owner_email is distinct from old.owner_email or new.email is distinct from old.email
     or new.invitation_id is distinct from old.invitation_id or new.added_at is distinct from old.added_at then
    raise exception 'a membership''s identity cannot change';
  end if;
  if old.removed_at is not null and new.removed_at is distinct from old.removed_at then
    raise exception 'a removed membership cannot be restored; invite the person again';
  end if;
  return new;
end
$$;

drop trigger if exists subscription_members_guard on public.subscription_members;
create trigger subscription_members_guard before update or delete on public.subscription_members
  for each row execute function public.gf_member_guard();

-- ---------------------------------------------------------------------------
-- E. The lock every seat-adding statement takes first
-- ---------------------------------------------------------------------------
create or replace function public.gf_lock_owner_subscription(p_owner text) returns public.subscriptions
language plpgsql as $$
declare s public.subscriptions;
begin
  select * into s from public.subscriptions
   where email = p_owner and status in ('active', 'past_due')
   order by created_at desc limit 1
   for update;
  return s;
end
$$;

-- ---------------------------------------------------------------------------
-- F. Invite: the seat is RESERVED while the offer is open, so an owner cannot promise more seats than the plan has.
-- ---------------------------------------------------------------------------
create or replace function public.gf_invite_member(
  p_owner text, p_invitee text, p_id uuid, p_token_hash text, p_expires_at timestamptz
) returns jsonb
language plpgsql as $$
declare
  o text := lower(btrim(coalesce(p_owner, '')));
  e text := lower(btrim(coalesce(p_invitee, '')));
  s public.subscriptions;
  seats int;
  members int;
  pending int;
  inv public.subscription_invitations;
begin
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '30 days' then
    raise exception 'p_expires_at must be within the next 30 days' using errcode = '22023';
  end if;
  if position('@' in e) <= 1 or length(e) > 254 or e ~ '\s' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_email');
  end if;

  s := public.gf_lock_owner_subscription(o);
  if s.id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_subscription');
  end if;
  if e = o then
    return jsonb_build_object('ok', false, 'reason', 'is_owner');
  end if;

  -- Retire offers that ran out, so they neither hold a seat nor block a fresh invitation.
  update public.subscription_invitations set status = 'expired'
   where owner_email = o and status = 'pending' and expires_at <= now();

  if exists (select 1 from public.subscription_members where owner_email = o and email = e and removed_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'already_member');
  end if;
  if exists (select 1 from public.subscription_invitations where owner_email = o and email = e and status = 'pending') then
    return jsonb_build_object('ok', false, 'reason', 'already_invited');
  end if;

  seats := public.gf_plan_seats(s.plan);
  select count(*) into members from public.subscription_members where owner_email = o and removed_at is null;
  select count(*) into pending from public.subscription_invitations where owner_email = o and status = 'pending';
  if seats is not null and 1 + members + pending >= seats then
    return jsonb_build_object('ok', false, 'reason', 'no_seats', 'seats', seats, 'used', 1 + members, 'reserved', pending);
  end if;

  insert into public.subscription_invitations (id, owner_email, email, token_hash, expires_at)
  values (p_id, o, e, p_token_hash, p_expires_at) returning * into inv;
  -- The email is owed from the moment the seat is held: its obligation is written in THIS transaction (the dedupe key is the
  -- one lib/notifications.ts derives), so an invitation can never exist without a durable record that it must be sent, and
  -- there is no compensating step that could itself fail. The application then makes the first attempt and the cron sweep
  -- retries it. The row holds no recipient, secret or body (0021).
  insert into public.customer_notifications (dedupe_key, kind, subject_table, subject_id)
  values ('team_invitation:' || inv.id::text, 'team_invitation', 'subscription_invitations', inv.id)
  on conflict (dedupe_key) do nothing;
  return jsonb_build_object('ok', true, 'invitation_id', inv.id, 'expires_at', inv.expires_at);
end
$$;

-- ---------------------------------------------------------------------------
-- G. Read an invitation as the person it was sent to (no state change except retiring an expired offer)
-- ---------------------------------------------------------------------------
create or replace function public.gf_invitation_preview(p_token_hash text, p_email text) returns jsonb
language plpgsql as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  inv public.subscription_invitations;
  s public.subscriptions;
begin
  select * into inv from public.subscription_invitations where token_hash = p_token_hash;
  -- An unknown secret and somebody else's invitation are the same answer, so neither leaks who was invited.
  if inv.id is null or inv.email <> e then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if inv.status = 'accepted' then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if inv.status = 'declined' then return jsonb_build_object('ok', false, 'reason', 'declined'); end if;
  if inv.status = 'revoked' then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  if inv.status = 'expired' or inv.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;

  select * into s from public.subscriptions
   where email = inv.owner_email and status in ('active', 'past_due') order by created_at desc limit 1;
  if s.id is null then
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;
  return jsonb_build_object('ok', true, 'owner_email', inv.owner_email, 'plan', s.plan, 'expires_at', inv.expires_at);
end
$$;

-- ---------------------------------------------------------------------------
-- H. Accept: atomic with the seat check. The caller passes the VERIFIED email; it must be the invited one.
-- ---------------------------------------------------------------------------
create or replace function public.gf_accept_invitation(p_token_hash text, p_email text) returns jsonb
language plpgsql as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  seen public.subscription_invitations;
  inv public.subscription_invitations;
  s public.subscriptions;
  seats int;
  members int;
  already boolean;
begin
  select * into seen from public.subscription_invitations where token_hash = p_token_hash;
  if seen.id is null or seen.email <> e then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- Subscription first, then the invitation: the one lock order every seat-adding statement uses.
  s := public.gf_lock_owner_subscription(seen.owner_email);

  select * into inv from public.subscription_invitations where id = seen.id for update;
  if inv.status = 'accepted' then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if inv.status = 'declined' then return jsonb_build_object('ok', false, 'reason', 'declined'); end if;
  if inv.status = 'revoked' then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  if inv.status = 'expired' or inv.expires_at <= now() then
    update public.subscription_invitations set status = 'expired' where id = inv.id and status = 'pending';
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if s.id is null then
    -- The offer stays open: it grants nothing while the owner has no entitling subscription.
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;

  seats := public.gf_plan_seats(s.plan);
  select count(*) into members from public.subscription_members where owner_email = inv.owner_email and removed_at is null;
  select exists (select 1 from public.subscription_members
                  where owner_email = inv.owner_email and email = e and removed_at is null) into already;
  if not already and seats is not null and 1 + members + 1 > seats then
    return jsonb_build_object('ok', false, 'reason', 'no_seats', 'seats', seats, 'used', 1 + members);
  end if;

  if not already then
    insert into public.subscription_members (owner_email, email, invitation_id, added_at)
    values (inv.owner_email, e, inv.id, clock_timestamp());   -- the order seats were GRANTED (under the lock), not when the transaction began
  end if;
  update public.subscription_invitations set status = 'accepted', accepted_at = now() where id = inv.id;
  return jsonb_build_object('ok', true, 'owner_email', inv.owner_email, 'plan', s.plan, 'invitation_id', inv.id);
end
$$;

-- ---------------------------------------------------------------------------
-- I. Decline
-- ---------------------------------------------------------------------------
create or replace function public.gf_decline_invitation(p_token_hash text, p_email text) returns jsonb
language plpgsql as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  seen public.subscription_invitations;
  inv public.subscription_invitations;
begin
  select * into seen from public.subscription_invitations where token_hash = p_token_hash;
  if seen.id is null or seen.email <> e then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select * into inv from public.subscription_invitations where id = seen.id for update;
  if inv.status = 'accepted' then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if inv.status = 'declined' then return jsonb_build_object('ok', false, 'reason', 'declined'); end if;
  if inv.status = 'revoked' then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  if inv.status = 'expired' or inv.expires_at <= now() then
    update public.subscription_invitations set status = 'expired' where id = inv.id and status = 'pending';
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  update public.subscription_invitations set status = 'declined', declined_at = now() where id = inv.id;
  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------------
-- J. Revoke and remove: one statement each, scoped to the owner in the same statement.
-- ---------------------------------------------------------------------------
create or replace function public.gf_revoke_invitation(p_owner text, p_invitation uuid) returns jsonb
language plpgsql as $$
declare n int;
begin
  update public.subscription_invitations set status = 'revoked', revoked_at = now()
   where id = p_invitation and owner_email = lower(btrim(coalesce(p_owner, ''))) and status = 'pending';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n = 1, 'reason', case when n = 1 then null else 'not_pending' end);
end
$$;

create or replace function public.gf_remove_member(p_owner text, p_member uuid) returns jsonb
language plpgsql as $$
declare n int;
begin
  update public.subscription_members set removed_at = now()
   where id = p_member and owner_email = lower(btrim(coalesce(p_owner, ''))) and removed_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n = 1, 'reason', case when n = 1 then null else 'not_a_member' end);
end
$$;

-- ---------------------------------------------------------------------------
-- K. What the owner sees. One snapshot, so the counts and the lists agree.
-- A member beyond the plan's seat count (the owner moved to a smaller plan) is listed with seat_active = false and is
-- not entitled: seats are honoured in the order they were taken, oldest first.
-- ---------------------------------------------------------------------------
create or replace function public.gf_team_overview(p_owner text) returns jsonb
language plpgsql stable as $$
declare
  o text := lower(btrim(coalesce(p_owner, '')));
  s public.subscriptions;
  seats int;
begin
  select * into s from public.subscriptions
   where email = o and status in ('active', 'past_due') order by created_at desc limit 1;
  if s.id is null then return null; end if;
  seats := public.gf_plan_seats(s.plan);
  return jsonb_build_object(
    'subscription', jsonb_build_object('id', s.id, 'plan', s.plan, 'status', s.status),
    'seats', seats,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'email', x.email, 'added_at', x.added_at,
                                          'seat_active', seats is null or x.rn <= seats - 1) order by x.added_at, x.id)
        from (select m.id, m.email, m.added_at, row_number() over (order by m.added_at, m.id) as rn
                from public.subscription_members m where m.owner_email = o and m.removed_at is null) x
    ), '[]'::jsonb),
    'invitations', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'created_at', i.created_at,
                                          'expires_at', i.expires_at) order by i.created_at, i.id)
        from public.subscription_invitations i
       where i.owner_email = o and i.status = 'pending' and i.expires_at > now()
    ), '[]'::jsonb)
  );
end
$$;

-- ---------------------------------------------------------------------------
-- L. The entitlement a MEMBER holds: the owner's entitling subscription, if this address has a seat on it.
-- Called by lib/subscribers.ts only after the address has no entitling subscription of its own.
-- ---------------------------------------------------------------------------
create or replace function public.gf_member_entitlement(p_email text) returns jsonb
language plpgsql stable as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  result jsonb;
begin
  if e = '' then return null; end if;
  select jsonb_build_object('owner_email', s.email, 'subscription', to_jsonb(s)) into result
    from public.subscription_members m
    join lateral (select * from public.subscriptions s2
                   where s2.email = m.owner_email and s2.status in ('active', 'past_due')
                   order by s2.created_at desc limit 1) s on true
   where m.email = e and m.removed_at is null
     -- Seats are honoured oldest first: this seat counts only if fewer than (seats - 1) active seats of the owner precede it.
     and (public.gf_plan_seats(s.plan) is null
          or (select count(*) from public.subscription_members x
               where x.owner_email = m.owner_email and x.removed_at is null
                 and (x.added_at, x.id) <= (m.added_at, m.id)) <= public.gf_plan_seats(s.plan) - 1)
   order by s.created_at desc
   limit 1;
  return result;
end
$$;

-- ---------------------------------------------------------------------------
-- M. The invitation email is an obligation in the existing durable outbox (0021).
-- ---------------------------------------------------------------------------
alter table public.customer_notifications drop constraint if exists customer_notifications_kind_check;
alter table public.customer_notifications add constraint customer_notifications_kind_check
  check (kind in ('intake_link', 'api_access_link', 'watch_link', 'key_rotation', 'subscription_welcome', 'team_invitation'));
alter table public.customer_notifications drop constraint if exists customer_notifications_subject_table_check;
alter table public.customer_notifications add constraint customer_notifications_subject_table_check
  check (subject_table in ('deliverables', 'api_accounts', 'watches', 'subscriptions', 'subscription_invitations'));

-- ---------------------------------------------------------------------------
-- N. Service role only, at the table and the function layer (see 0020).
-- ---------------------------------------------------------------------------
alter table public.subscription_invitations enable row level security;
alter table public.subscription_members enable row level security;
-- No policies: the service role reaches these through app/api/team, which authenticates the caller first.
revoke all on public.subscription_invitations from public;
revoke all on public.subscription_members from public;

do $$
declare f text; r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.subscription_invitations from %I', r);
      execute format('revoke all on public.subscription_members from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.subscription_invitations to service_role;
    grant all on public.subscription_members to service_role;
  end if;

  for f in select unnest(array[
      'public.gf_plan_seats(text)',
      'public.gf_invitation_guard()',
      'public.gf_member_guard()',
      'public.gf_lock_owner_subscription(text)',
      'public.gf_invite_member(text, text, uuid, text, timestamptz)',
      'public.gf_invitation_preview(text, text)',
      'public.gf_accept_invitation(text, text)',
      'public.gf_decline_invitation(text, text)',
      'public.gf_revoke_invitation(text, uuid)',
      'public.gf_remove_member(text, uuid)',
      'public.gf_team_overview(text)',
      'public.gf_member_entitlement(text)']) loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end
$$;
