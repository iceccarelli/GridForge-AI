-- 0016_project_purchases.sql — a paid engagement attaches to the project that commissioned it
--
-- The project reference travels through the EXISTING money path: /api/checkout resolves
-- the project token and puts the project's id in the Stripe session metadata; the Stripe
-- webhook (the authoritative payment event) opens the deliverable / watch exactly as it
-- always did and then calls gf_attach_purchase below. Nothing here prices anything, adds
-- a product, or copies a deliverable: the project holds a link (deliverable, watch) and an
-- event saying what was bought. A deposit with no durable object (the Envelope Study
-- deposit) is recorded as the event alone.
--
-- Webhook redelivery is the normal case, so the function is idempotent by construction:
--   * an object already linked to this project  -> nothing written, {created:false};
--   * a Stripe session already attached          -> nothing written, {created:false};
--   * an object linked to ANOTHER project        -> refused (unique violation), never moved.

alter table public.project_events drop constraint if exists project_events_event_type_check;
alter table public.project_events add constraint project_events_event_type_check
  check (event_type in ('project_created', 'btm_case_attached', 'btm_case_revised',
                        'rfq_generated', 'supplier_response_received',
                        'comparison_completed', 'supplier_selected', 'evidence_attached',
                        'paid_product_attached'));

-- One project per purchased object, now including deliverables and watches.
drop index if exists public.project_links_one_project_per_object;
create unique index project_links_one_project_per_object
  on public.project_links (object_type, object_id)
  where object_type in ('power_deployment_case', 'procurement_package', 'deliverable', 'watch');

-- One attachment per Stripe checkout session, whatever the object.
create unique index if not exists project_events_one_purchase_per_session
  on public.project_events ((payload ->> 'stripe_session_id'))
  where event_type = 'paid_product_attached';

create or replace function public.gf_attach_purchase(p_project uuid, p_object_type text,
                                                     p_object_id text, p_event jsonb) returns jsonb
language plpgsql as $$
declare v uuid; c text;
begin
  if p_object_type is not null then
    if p_object_type not in ('deliverable', 'watch') then
      raise exception 'a purchase attaches as a deliverable or a watch, not %', p_object_type
        using errcode = '22023';
    end if;
    insert into public.project_links (project_id, object_type, object_id)
    values (p_project, p_object_type, p_object_id)
    on conflict (project_id, object_type, object_id) do nothing
    returning id into v;
    if v is null then
      return jsonb_build_object('created', false);   -- already attached: its event exists too
    end if;
  end if;
  perform public.gf_emit(p_project, p_event);
  return jsonb_build_object('created', true);
exception when unique_violation then
  get stacked diagnostics c = constraint_name;
  if c = 'project_links_one_project_per_object' then
    raise;                                            -- belongs to another project: refuse
  end if;
  return jsonb_build_object('created', false);        -- this Stripe session was already attached
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.gf_attach_purchase(uuid, text, text, jsonb) from public;
    grant execute on function public.gf_attach_purchase(uuid, text, text, jsonb) to service_role;
  end if;
end
$$;
