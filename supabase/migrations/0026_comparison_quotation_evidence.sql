-- 0026_comparison_quotation_evidence.sql — a saved comparison names the accepted quotations it was priced on
--
-- 0025 stores a comparison as the request and the engine's answer, verbatim. A comparison can now be priced on the
-- project's accepted supplier quotations (0022): the request then carries those lines and the answer says which it applied.
-- This migration adds the one thing that cannot be left to the application: the database's own record of WHICH quotation
-- lines a comparison rests on, and a refusal to write that claim unless it is true at the instant of the write.
--
--   evidence_ids   the cost_evidence lines whose prices the comparison's numbers rest on. Empty = library cost data only
--                  (every row saved before this migration, which is true of them). Append-only like the rest of the row:
--                  a later withdrawal or replacement of a line never rewrites a saved comparison; the read side compares
--                  these ids with the lines' current state and reports the comparison as no longer current.
--
--   gf_save_comparison now, when evidence_ids is non-empty, takes the same advisory lock that 0022 review and withdrawal
--   take for each (engagement, cost key) and then requires, in the same transaction, that every line is ACCEPTED (not
--   received, rejected, superseded or withdrawn), stamped with THIS project and reachable from it through project_links,
--   in EUR and not a synthetic fixture. A line that was withdrawn while the engine was answering therefore cannot be
--   stored as backing a comparison, and a line of another project can never be named by this one. A brand-new project has
--   no quotations, so a create-and-save that names evidence is refused.
--
-- Nothing is priced here, no product or entitlement changes, and no existing row is touched.

alter table public.project_comparisons
  add column if not exists evidence_ids uuid[] not null default '{}';

create or replace function public.gf_save_comparison(p jsonb, p_event jsonb,
                                                     p_new_project jsonb default null,
                                                     p_new_event jsonb default null) returns jsonb
language plpgsql as $$
declare pid uuid; r public.project_comparisons; ids uuid[]; k record; ok int;
begin
  if p_new_project is not null then
    pid := (public.gf_create_project(p_new_project, p_new_event)->>'id')::uuid;
  else
    pid := (p->>'project_id')::uuid;
  end if;

  ids := coalesce(array(select distinct x::uuid
                          from jsonb_array_elements_text(coalesce(p->'evidence_ids', '[]'::jsonb)) x), '{}');
  if cardinality(ids) > 0 then
    if p_new_project is not null then
      raise exception 'a new project has no accepted quotations to rest a comparison on' using errcode = '23514';
    end if;
    -- Take turns with review and withdrawal of these lines (0022 locks per engagement and cost key), in a fixed order.
    for k in select distinct e.deliverable_id, e.cost_key from public.cost_evidence e
              where e.id = any(ids) order by e.deliverable_id, e.cost_key loop
      perform pg_advisory_xact_lock(hashtextextended(k.deliverable_id::text || ':' || k.cost_key, 0));
    end loop;
    select count(*) into ok from public.cost_evidence_state s
     where s.id = any(ids)
       and s.state = 'accepted'
       and s.project_id = pid
       and s.currency = 'EUR'
       and not s.synthetic
       and exists (select 1 from public.project_links l
                    where l.project_id = pid and l.object_type = 'deliverable'
                      and l.object_id = s.deliverable_id::text);
    if ok <> cardinality(ids) then
      raise exception 'a comparison can only rest on accepted quotations of its own project' using errcode = '23514';
    end if;
  end if;

  insert into public.project_comparisons (project_id, request, result, schema, request_digest,
                                          provenance_digest, engine_version, grade, evidence_ids, saved_at)
  values (pid, p->'request', p->'result', p->>'schema', p->>'request_digest',
          p->>'provenance_digest', p->>'engine_version', p->>'grade', ids,
          coalesce((p->>'saved_at')::timestamptz, now()))
  on conflict (project_id, request_digest, provenance_digest) do nothing
  returning * into r;

  if not found then
    select * into r from public.project_comparisons
     where project_id = pid and request_digest = p->>'request_digest'
       and provenance_digest = p->>'provenance_digest';
    return jsonb_build_object('created', false, 'project_id', pid, 'comparison_id', r.id);
  end if;

  perform public.gf_emit(pid, p_event, jsonb_build_object('comparison_id', r.id));
  return jsonb_build_object('created', true, 'project_id', pid, 'comparison_id', r.id);
end;
$$;

do $$
declare r text;
begin
  revoke all on function public.gf_save_comparison(jsonb, jsonb, jsonb, jsonb) from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.gf_save_comparison(jsonb, jsonb, jsonb, jsonb) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.gf_save_comparison(jsonb, jsonb, jsonb, jsonb) to service_role;
  end if;
end
$$;
