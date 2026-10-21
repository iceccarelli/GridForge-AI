-- 0037_release_notice_and_row_version.sql — the release email is a durable obligation; a deliverable row has a version
--
-- 1. RELEASE NOTICE. The email that tells a buyer their reviewed document is ready was one best-effort send whose failure
--    (or a buyer with no address on record) was returned to the operator and persisted nowhere: nothing retried it and nothing
--    listed it. It is now an obligation in the durable outbox (0021): kind deliverable_release, subject = the deliverables row
--    (subject table 'deliverables' is already allowed), one per release of a given pack (the dedupe key carries the pack hash),
--    rebuilt from the row at send time and cancelled unsent if the document has been pulled back. Stores no recipient, link or body.
--
-- 2. ROW VERSION. deliverables.row_version is bumped by every UPDATE (a trigger), so a read-modify-write of a row's
--    working_files (the buyer's bid comparison) can be a compare-and-set on the version it read instead of overwriting what a
--    concurrent writer stored. Additive: existing rows start at 0, and code that does not send a version is unaffected.
--
-- Additive and idempotent. Re-states the check 0034 last set (the pattern 0032 and 0034 follow).

alter table public.customer_notifications drop constraint if exists customer_notifications_kind_check;
alter table public.customer_notifications add constraint customer_notifications_kind_check
  check (kind in ('intake_link', 'api_access_link', 'watch_link', 'key_rotation', 'subscription_welcome', 'team_invitation', 'usage_alert', 'payg_payment_failed', 'deposit_receipt', 'deliverable_release'));

-- Nullable on purpose: a restore of an export taken before this column existed (scripts/verify-backup-restore.py loads it with
-- jsonb_populate_recordset, which gives a missing key as NULL and not as the default) must still load. NULL reads as "no
-- version" in the application (no compare-and-set) and the trigger starts it at 1 on the first update.
alter table public.deliverables add column if not exists row_version bigint default 0;

create or replace function public.gf_deliverable_version() returns trigger
language plpgsql as $$
begin
  new.row_version := coalesce(old.row_version, 0) + 1;
  return new;
end;
$$;

drop trigger if exists deliverables_version on public.deliverables;
create trigger deliverables_version
  before update on public.deliverables
  for each row execute function public.gf_deliverable_version();

do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.gf_deliverable_version() from %I', r);
    end if;
  end loop;
  revoke all on function public.gf_deliverable_version() from public;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.gf_deliverable_version() to service_role;
  end if;
end
$$;
