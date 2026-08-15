-- 044: Atomically resolve an email-review item.
--
-- One transaction: apply the selected fixes (each only if the cell has not
-- changed since it was flagged - per-cell revision CAS - so a concurrent run
-- never gets silently clobbered), update the QA cell's value + verdict for the
-- export gate, and mark the review item resolved. A stale cell aborts the whole
-- resolution rather than half-applying. resolution_key makes a retry idempotent.

create or replace function public.enrichment_review_resolve(
  p_item_id uuid,
  p_decision text,
  p_resolver text,
  p_resolution_key text
)
returns text
language plpgsql
as $$
declare
  v_item public.enrichment_review_items;
  v_prop record;
  v_qa_value text;
  v_verdict text;
  v_updated integer;
begin
  if p_decision not in ('accepted', 'declined_export', 'declined_hold') then
    raise exception 'invalid decision %', p_decision;
  end if;

  select * into v_item from public.enrichment_review_items where id = p_item_id for update;
  if not found then raise exception 'review item not found'; end if;

  -- Idempotent replay of the same resolution returns its prior result.
  if v_item.resolution_key is not null and v_item.resolution_key = p_resolution_key then
    return v_item.status;
  end if;
  -- Already resolved (by another reviewer or an earlier click): return actual state.
  if v_item.status <> 'pending' then
    return v_item.status;
  end if;

  if p_decision = 'accepted' then
    for v_prop in
      select * from public.enrichment_review_proposals
      where review_item_id = p_item_id and selected and column_id is not null and proposed_value is not null
    loop
      update public.enrichment_cell_values c
      set value = v_prop.proposed_value,
          revision = c.revision + 1,
          updated_at = now(),
          updated_by = p_resolver
      where c.column_id = v_prop.column_id
        and c.lead_id = v_item.lead_id
        and (v_prop.expected_cell_revision is null or c.revision = v_prop.expected_cell_revision);
      get diagnostics v_updated = row_count;
      if v_updated = 0 then
        -- The cell changed since it was flagged (or vanished): stale. Aborting
        -- rolls back every write in this resolution.
        raise exception 'stale_cell:%', v_prop.column_key;
      end if;
    end loop;
    v_qa_value := 'Ready'; v_verdict := 'ready';
  elsif p_decision = 'declined_export' then
    v_qa_value := 'Ready'; v_verdict := 'ready';
  else
    v_qa_value := 'Needs review'; v_verdict := 'needs_review';
  end if;

  -- Keep the QA cell value + details.verdict as the backward-compatible export
  -- gate (exportLeadCore + the UI still read these).
  if v_item.qa_column_id is not null then
    update public.enrichment_cell_values c
    set value = v_qa_value,
        revision = c.revision + 1,
        details = jsonb_set(
                    jsonb_set(coalesce(c.details, '{}'::jsonb), '{verdict}', to_jsonb(v_verdict)),
                    '{decision}', to_jsonb(p_decision)
                  ),
        updated_at = now(),
        updated_by = p_resolver
    where c.column_id = v_item.qa_column_id and c.lead_id = v_item.lead_id;
  end if;

  update public.enrichment_review_items
  set status = p_decision,
      resolved_by = p_resolver,
      resolved_at = now(),
      resolution_key = p_resolution_key,
      lock_version = lock_version + 1
  where id = p_item_id;

  return p_decision;
end;
$$;

revoke execute on function public.enrichment_review_resolve(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.enrichment_review_resolve(uuid, text, text, text) to service_role;

notify pgrst, 'reload schema';
