-- 0012_intake_token.sql — separate "fill this in" from "read the document"
--
-- `deliverables.token` is one credential doing two jobs: /intake/<token> submits
-- the hall's numbers, and /deliverable/<token> reads the released engineering
-- opinion. That was fine while the only way to get it was an email to the person
-- who paid.
--
-- It stops being fine the moment anything else hands it out. /commissioned wants
-- to show the intake link immediately after payment — which removes email as the
-- single point of failure between a five-figure purchase and its fulfilment — but
-- publishing `token` on a page keyed by a Stripe session id would make that
-- session id equivalent to the document credential, and put it in browser history,
-- referrers and any analytics on the page.
--
-- So the two jobs get two credentials. `intake_token` grants exactly one thing:
-- submit this engagement's numbers. It is safe to show at the moment of payment
-- because the worst it can do is fill in a form for an engagement that has already
-- been bought. Reading the document still requires `token`, which is only ever
-- sent to the customer directly.
--
-- Nullable, because rows created before this have only `token` and must keep
-- working: the intake route accepts either, and only ever discloses this one.
alter table public.deliverables
  add column if not exists intake_token text;

create unique index if not exists deliverables_intake_token_idx
  on public.deliverables (intake_token)
  where (intake_token is not null);
