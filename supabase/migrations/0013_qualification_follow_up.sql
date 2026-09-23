-- 0013_qualification_follow_up.sql — a qualified read that asks for a human, once
--
-- The share link (0008) let a capacity read leave the browser tab. It did not give
-- the person holding it any way to say "come and talk to me" — the only paths
-- forward were re-typing seven numbers into a new qualifier or buying a EUR 4,500
-- engagement cold. Everything in between (a director who wants a person on the
-- phone before they commit budget) had no button.
--
-- `follow_up_requested_at` is the whole mechanism: a nullable timestamp, set once,
-- by the buyer's own action, never by a scheduled job. The unique constraint the
-- column relies on is behavioural, not declared in SQL — the API route only ever
-- writes it conditioned on `follow_up_requested_at is null`, so a second click (or
-- a retried request) is a no-op rather than a second email. See
-- app/api/qualify/[token]/follow-up/route.ts and tests/site/qualify-followup.test.ts.
alter table public.qualifications add column if not exists follow_up_requested_at timestamptz;
alter table public.qualifications add column if not exists follow_up_email text;
alter table public.qualifications add column if not exists follow_up_note text;

create index if not exists qualifications_follow_up_idx
  on public.qualifications (follow_up_requested_at)
  where follow_up_requested_at is not null;
