-- 0044_intake_evidence.sql: the buyer's own documents behind the numbers of a purchased engagement, and the values they confirm from them.
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision; nothing in the application needs the tables to
-- exist until a buyer uses the new panel on /intake/<token>, and the routes answer 503 ("evidence is not available") until then.
--
-- Additive and idempotent: only `create ... if not exists` / `create or replace`, nothing existing is touched, and both new tables are
-- created with RLS on and no policies (service role only), like every table that holds a customer's material (0015, 0020, 0040).
--
--   intake_evidence_files   one row per file a buyer attached to ONE engagement (deliverables.id). The bytes live in the private
--                           `project-evidence` bucket under that deliverable's own prefix; the row is the inventory: name, type, size, the
--                           SHA-256 of the bytes and where they are. The contents are never read or interpreted by the application.
--   intake_value_events     append-only history of what the buyer CONFIRMED from a file: "firm connection capacity is 40 MVA, clause 4.2
--                           of this file", or the withdrawal of that. The effective value of a field is its newest event; a withdrawal
--                           leaves the earlier confirmation in place as history. A value is only ever a number the buyer typed against a
--                           file and attested to: nothing here extracts a figure from a document.
--
-- Defence in depth (the application checks the same things first):
--   * a confirmation must cite a file of the SAME engagement (composite foreign key),
--   * the unit is fixed by the field, so a value cannot be filed under the wrong unit,
--   * the number is finite and positive (NaN and Infinity are refused here as well as in the parser),
--   * neither table can change after the engagement has left intake: once the document is generated from these values, the record of
--     what it used must not move (trigger on insert), and neither table can be updated or deleted at all (gf_append_only, 0015).

create table if not exists public.intake_evidence_files (
  id uuid primary key default gen_random_uuid(),
  deliverable_id uuid not null references public.deliverables (id),
  filename text not null check (length(filename) between 1 and 200),
  media_type text not null check (media_type in ('application/pdf', 'text/csv', 'application/json')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 5242880),
  -- '<bucket>/<path>' of the stored object.
  storage_ref text not null,
  uploaded_at timestamptz not null default now(),
  -- The same bytes are one file per engagement; and a pair a confirmation can reference.
  unique (deliverable_id, sha256),
  unique (deliverable_id, id)
);

create index if not exists intake_evidence_files_deliverable_idx on public.intake_evidence_files (deliverable_id);

create table if not exists public.intake_value_events (
  id uuid primary key default gen_random_uuid(),
  -- The order events happened in (the clock can repeat inside one transaction; this cannot).
  seq bigint generated always as identity,
  deliverable_id uuid not null references public.deliverables (id),
  action text not null check (action in ('confirm', 'withdraw')),
  field text not null check (field in ('firmCapacityMVA', 'floorLoadingKPa', 'plantCapacityKW')),
  value double precision,
  unit text,
  file_id uuid,
  -- Where in the file the number is ("clause 4.2", "page 3, table 1"): so a reviewer can find it.
  locator text,
  -- Who attested: the buyer's email as it stands on the engagement, set by the server and never taken from the request.
  confirmed_by text,
  occurred_at timestamptz not null default now(),
  foreign key (deliverable_id, file_id) references public.intake_evidence_files (deliverable_id, id),
  constraint intake_value_events_shape check (
    (action = 'confirm'
       and value is not null and value > 0 and value <> 'NaN'::float8 and value < 'Infinity'::float8
       and file_id is not null
       and locator is not null and length(locator) between 1 and 200
       and (field, unit) in (('firmCapacityMVA', 'MVA'), ('floorLoadingKPa', 'kPa'), ('plantCapacityKW', 'kW')))
    or
    (action = 'withdraw' and value is null and unit is null and file_id is null and locator is null)
  )
);

create index if not exists intake_value_events_deliverable_idx on public.intake_value_events (deliverable_id, seq);

-- Evidence for an engagement can change only while it is still taking its intake (the same two statuses /api/intake/<token> accepts).
create or replace function public.gf_intake_evidence_open() returns trigger
language plpgsql as $$
declare s text;
begin
  select status into s from public.deliverables where id = new.deliverable_id;
  if s is null or s not in ('awaiting_intake', 'engine_unavailable') then
    raise exception 'evidence for engagement % can no longer change (status %)', new.deliverable_id, coalesce(s, 'missing')
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists intake_evidence_files_open on public.intake_evidence_files;
create trigger intake_evidence_files_open
  before insert on public.intake_evidence_files
  for each row execute function public.gf_intake_evidence_open();

drop trigger if exists intake_value_events_open on public.intake_value_events;
create trigger intake_value_events_open
  before insert on public.intake_value_events
  for each row execute function public.gf_intake_evidence_open();

drop trigger if exists intake_evidence_files_append_only on public.intake_evidence_files;
create trigger intake_evidence_files_append_only
  before update or delete on public.intake_evidence_files
  for each row execute function public.gf_append_only();

drop trigger if exists intake_value_events_append_only on public.intake_value_events;
create trigger intake_value_events_append_only
  before update or delete on public.intake_value_events
  for each row execute function public.gf_append_only();

alter table public.intake_evidence_files enable row level security;
alter table public.intake_value_events enable row level security;
-- No policies: service role only.

do $$
declare r text;
begin
  revoke all on table public.intake_evidence_files, public.intake_value_events from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.intake_evidence_files, public.intake_value_events from %I', r);
    end if;
  end loop;
end;
$$;
