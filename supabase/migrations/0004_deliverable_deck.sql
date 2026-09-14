-- 0004_deliverable_deck.sql — the walkthrough deck stored beside the document
--
-- The Envelope Study includes a session with the client's engineering team, and
-- that session is where the follow-on engagement is won. The deck is generated
-- from the same solved model as the document, so the two can never disagree.
alter table public.deliverables add column if not exists deck_html text;
