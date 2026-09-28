-- 0014_power_deployment_cases.sql — the persistent BTM Power Deployment Case
--
-- gridforge/reporting/btm_assessment.py composes a real load profile and
-- declared generation/BESS units into one architecture comparison, and it is
-- reachable over the CLI, REST and MCP — but every call composes fresh. There
-- is no case: a customer who updates one input (a battery quote landed, the
-- load grew) has to resend the whole request and gets no answer to "what
-- changed since last time," which is the whole commercial point of a Watch.
--
-- This table is the smallest thing that fixes that: one row per revision, not
-- one mutable blob per case. `case_token` groups revisions of the same case;
-- `revision` is monotonic within it; the newest revision's `result` is what a
-- GET returns, and the previous revision's `result` is what a re-solve diffs
-- against for "what changed." This is the same shape watches.last_state
-- already uses for Hall Watch — one JSONB snapshot compared against the next
-- one — not a new persistence pattern invented for this table alone.
create table if not exists public.power_deployment_cases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  case_token text not null,
  revision int not null default 1,
  email text,
  company text,
  project_name text,
  -- The exact wire shape gridforge.reporting.btm_assessment.deployment_request()
  -- parses. Stored verbatim so a re-solve is reproducible and a support request
  -- can be replayed against a newer engine build without asking the customer to
  -- retype anything.
  request jsonb not null,
  -- gridforge.reporting.btm_assessment.assess_deployment()'s output, verbatim.
  -- The one place the engine's answer for this revision is written down; the
  -- workspace and the API both read this column, never recompute a stale
  -- comparison client-side.
  result jsonb not null,
  -- Named inputs the case actually changed on this revision, for a change note
  -- cheaper than diffing two full JSONB blobs client-side on every read. Empty
  -- on revision 1 (nothing to compare against). Never invented: set only from
  -- an actual field-by-field comparison against the previous revision's
  -- request, in app/api/power/deploy/cases/[token]/route.ts.
  changed_fields text[] not null default '{}',
  unique (case_token, revision)
);

create index if not exists power_deployment_cases_token_idx
  on public.power_deployment_cases (case_token, revision desc);

alter table public.power_deployment_cases enable row level security;
-- No policies: reached only through app/api/power/deploy/cases, which is the
-- service role, exactly like watches and scenarios above it in this directory.
