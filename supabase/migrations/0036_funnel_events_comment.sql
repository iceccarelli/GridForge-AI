-- 0036_funnel_events_comment.sql — say precisely what the database fences on funnel_events (documentation only; additive, idempotent)
--
-- 0028 and 0035 describe the allow-list in lib/funnel.ts as having the database as a "second fence". That overstated it. What the
-- DATABASE enforces is only: the event NAME is one of a fixed list (a check constraint, widened in 0035) and `props` is a JSON object.
-- It does NOT constrain which property KEYS or VALUES appear inside props: that fence is lib/funnel.ts alone (exact per-key value shapes,
-- no emails, tokens, names, sentences or card numbers), covered by tests/site/payg-funnel-report.test.ts. Anyone with service-role access
-- could write anything into props; nothing here claims otherwise. 0028 is not edited (it may already be applied); this records the truth.

comment on table public.funnel_events is
  'Product events. DB fence: name is one of a fixed list (check) and props is a JSON object. NOT fenced in the database: property keys and values; those are constrained only by lib/funnel.ts (the only writer). dedupe_key holds an opaque keyed digest, never a readable key.';
comment on column public.funnel_events.props is
  'JSON object. Keys and values are validated by lib/funnel.ts before insert, not by a database constraint.';
