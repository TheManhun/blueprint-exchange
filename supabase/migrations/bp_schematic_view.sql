-- Blueprint schematic view (Epod: the card can switch between the player's
-- screenshot and a drawn blueprint-style schematic). PURELY ADDITIVE on
-- purpose: the live bp_upload / bp_list bodies carry the dependency wiring
-- that this repo's copies predate, so this migration must not touch them.
-- Two tiny new RPCs instead; the site calls them alongside the old ones and
-- copes fine when they are absent (pre-migration).
--
-- APPLY: paste into the Supabase SQL editor (project aijqcrrcreectihaeqoc).

alter table public.bp_blueprints
  add column if not exists schematic_url text
    check (schematic_url is null or char_length(schematic_url) <= 300);

-- Attach the drawn schematic to a just-uploaded blueprint. Deliberately
-- narrow: only the R2 bucket's own URL pattern, only when none is set yet,
-- and only on a row younger than ten minutes -- the same trust model as the
-- rest of the no-accounts design, with a vandal window that rounds to zero.
create or replace function public.bp_set_schematic(p_id bigint, p_url text)
returns boolean language plpgsql security definer
set search_path = public as $$
declare
  v_url text := nullif(trim(coalesce(p_url, '')), '');
begin
  if v_url is null
     or v_url !~ '^https://pub-ea55f87d66c04139a2a7ac3704e9c05e\.r2\.dev/blueprints/[a-zA-Z0-9-]+\.webp$' then
    return false;
  end if;

  update public.bp_blueprints
     set schematic_url = v_url
   where id = p_id
     and schematic_url is null
     and created_at > now() - interval '10 minutes';

  return found;
end $$;

grant execute on function public.bp_set_schematic(bigint, text) to anon;

-- The schematics for a page of listed blueprints (merged into bp_list's
-- rows client-side; bp_list itself stays untouched).
create or replace function public.bp_schematics(p_ids bigint[])
returns table (id bigint, schematic_url text)
language sql security definer
set search_path = public as $$
  select b.id, b.schematic_url
    from public.bp_blueprints b
   where b.id = any (p_ids)
     and b.schematic_url is not null;
$$;

grant execute on function public.bp_schematics(bigint[]) to anon;
