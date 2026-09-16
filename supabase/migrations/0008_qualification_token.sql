-- 0008_qualification_token.sql — a qualification result that can leave the browser
--
-- The qualifier produced a real engineering answer and then lost it the moment the
-- tab closed. That matters commercially more than it looks: the person who runs a
-- capacity qualifier is an operations engineer, and the person who signs off a
-- five-figure study is a director. The distance between them is a link, and there
-- was not one.
--
-- The token is the credential, same pattern as deliverables and watches. It is
-- unguessable and the page is noindex: this is somebody's hall, shared by them,
-- with whoever they choose.
alter table public.qualifications add column if not exists token text;

-- Backfill before the unique index, or the index refuses on the existing nulls.
update public.qualifications
   set token = encode(gen_random_bytes(18), 'base64')
 where token is null;

update public.qualifications
   set token = replace(replace(replace(token, '+', '-'), '/', '_'), '=', '')
 where token like '%+%' or token like '%/%' or token like '%=%';

alter table public.qualifications alter column token set not null;
create unique index if not exists qualifications_token_idx on public.qualifications (token);
