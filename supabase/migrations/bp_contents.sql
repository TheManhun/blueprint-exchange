-- What a blueprint holds, in the mod's own icon language: "station:1;bus:2;road:23;other:1"
-- (the mod's bp_summary.categorize -- the same counts as the in-game Library row). The card's
-- Contents button drops those icons (icons/<key>.png) over the picture.
-- Applied 2026-09-28 as migration bp_contents; the 46 existing rows were backfilled with the
-- mod's own Lua (a temporary read function was created for that and dropped straight after).
alter table public.bp_blueprints add column if not exists contents text
  check (contents is null or (char_length(contents) <= 400 and contents ~ '^([a-z]+:[0-9]+)(;[a-z]+:[0-9]+)*$'));

-- New uploads: the upload page counts (bpxContentsOf, a line-for-line port) and attaches the
-- result right after bp_upload. Only fills an EMPTY contents, like bp_set_schematic.
create or replace function public.bp_set_contents(p_id bigint, p_contents text)
 returns boolean language plpgsql security definer set search_path to 'public'
as $function$
declare
  v text := nullif(trim(coalesce(p_contents, '')), '');
begin
  if v is null or char_length(v) > 400 or v !~ '^([a-z]+:[0-9]+)(;[a-z]+:[0-9]+)*$' then
    return false;
  end if;
  update public.bp_blueprints set contents = v where id = p_id and contents is null;
  return found;
end $function$;
grant execute on function public.bp_set_contents(bigint, text) to anon;

-- bp_list returns 'contents' with each card (see bp_preinstalled.sql for the rest of it).
