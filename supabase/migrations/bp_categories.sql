-- Migration "bp_categories": automatic blueprint categories, worked out from
-- the blueprint's own data (never typed in by the uploader).
--
-- Rules (mirrored in site.js bpxCategories -- keep the two in step):
--   constructions the file places decide the station types:
--     station/street/*  with cargo modules       -> Truck station
--     station/street/*  with passenger modules   -> Bus station
--     station/rail/*                             -> Rail station
--     station/air/*                              -> Airport
--     station/water/*                            -> Harbour
--     depot/*                                    -> Depot
--   if nothing station-like is placed the layout is plain infrastructure:
--     the file lists street types                -> Road network
--     the file lists track types                 -> Rail network
--   the file lists bridge or tunnel types        -> Bridges & tunnels
--   nothing recognised at all                    -> Other
-- The order above is the order stored, so the first entry is the primary one.

alter table public.bp_blueprints add column if not exists categories text[] not null default '{}';

create or replace function public.bp_categories(p_content text)
returns text[] language plpgsql immutable
set search_path = public as $$
declare
  cats text[] := '{}';
  street_station boolean := coalesce(p_content ~ 'fileName = "station/street/', false);
begin
  if p_content is null then return array['Other']; end if;

  if street_station and p_content ~ 'station/street/(cargo_platform|era_[a-z]_cargo_building)' then cats := array_append(cats, 'Truck station'::text); end if;
  if street_station and p_content ~ 'station/street/(passenger_platform|era_[a-z]_passenger_building)' then cats := array_append(cats, 'Bus station'::text); end if;
  if p_content ~ 'fileName = "station/rail/' then cats := array_append(cats, 'Rail station'::text); end if;
  if p_content ~ 'fileName = "station/air/' then cats := array_append(cats, 'Airport'::text); end if;
  if p_content ~ 'fileName = "station/water/' then cats := array_append(cats, 'Harbour'::text); end if;
  if p_content ~ 'fileName = "depot/' then cats := array_append(cats, 'Depot'::text); end if;

  -- plain infrastructure only when nothing station-like (even an unrecognised one) is placed
  if cardinality(cats) = 0 and not (p_content ~ 'fileName = "(station|depot)/') then
    if p_content ~ 'streets = \{"' then cats := array_append(cats, 'Road network'::text); end if;
    if p_content ~ 'tracks = \{"' then cats := array_append(cats, 'Rail network'::text); end if;
  end if;
  if p_content ~ 'bridges = \{"' or p_content ~ 'tunnels = \{"' then cats := array_append(cats, 'Bridges & tunnels'::text); end if;

  if cardinality(cats) = 0 then cats := array['Other']; end if;
  return cats;
end $$;

grant execute on function public.bp_categories(text) to anon, authenticated;

-- existing rows (derived data only; nothing else is touched)
update public.bp_blueprints set categories = public.bp_categories(content) where categories = '{}';

-- bp_list: same as before, plus categories
create or replace function public.bp_list()
returns jsonb language sql security definer
set search_path = public as $$
  with latest as (
    select distinct on (coalesce(blueprint_id, id::text)) *
    from public.bp_blueprints
    order by coalesce(blueprint_id, id::text), version desc, created_at desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'created_at', created_at, 'name', name, 'author', author,
    'description', description, 'game', game, 'constructions', constructions,
    'edges', edges, 'requires', requires, 'downloads', downloads,
    'size', char_length(content), 'blueprint_id', blueprint_id, 'version', version,
    'official', official, 'thumbnail_url', thumbnail_url, 'categories', categories
  ) order by official desc, created_at desc), '[]'::jsonb)
  from latest;
$$;

-- bp_upload: same argument list as before (no overload); stores the categories
create or replace function public.bp_upload(
  p_name text, p_author text, p_description text, p_content text, p_constructions integer,
  p_edges integer, p_requires jsonb, p_blueprint_id text,
  p_thumbnail_url text default null, p_owner_secret text default null)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_display text;
  v_official boolean := false;
  v_author text := nullif(trim(p_author), '');
  v_version int := 1;
  v_id bigint;
  v_thumb text := nullif(trim(coalesce(p_thumbnail_url, '')), '');
  v_secret text := nullif(trim(coalesce(p_owner_secret, '')), '');
  v_secret_hash text;
  v_existing_hash text;
  v_content text := p_content;
begin
  select display_name into v_display from public.bp_official_keys where passphrase = trim(p_author) limit 1;
  if v_display is not null then
    v_official := true;
    v_author := v_display;
  end if;

  if v_thumb is not null and v_thumb !~ '^https://pub-ea55f87d66c04139a2a7ac3704e9c05e\.r2\.dev/blueprints/[a-zA-Z0-9-]+\.webp$' then
    v_thumb := null;
  end if;

  if p_blueprint_id is not null then
    select coalesce(max(version), 0) + 1 into v_version from public.bp_blueprints where blueprint_id = p_blueprint_id;
    select secret_hash into v_existing_hash from public.bp_blueprint_owners where blueprint_id = p_blueprint_id;

    if v_existing_hash is null then
      if v_secret is not null then
        insert into public.bp_blueprint_owners (blueprint_id, secret_hash)
        values (p_blueprint_id, encode(extensions.digest(v_secret, 'sha256'), 'hex'));
      end if;
    else
      v_secret_hash := case when v_secret is not null then encode(extensions.digest(v_secret, 'sha256'), 'hex') else null end;
      if v_secret_hash is null or v_secret_hash <> v_existing_hash then
        raise exception 'This blueprint was already uploaded by someone else -- only the original uploader''s own file can update it.';
      end if;
    end if;
  end if;

  v_content := regexp_replace(v_content,
    '\m(ownerSecret|ownerKey|owner_key|editKey|recoveryToken|browserToken)\s*=\s*"[^"]*"\s*,?\s*', '', 'g');
  if v_content ~* '(ownersecret|ownerkey|owner_key|editkey|recoverytoken|browsertoken)'
     or (v_secret is not null and char_length(v_secret) >= 16 and position(v_secret in v_content) > 0) then
    raise exception 'This file still contains ownership data that cannot be published. Upload the file exactly as the mod saved it.';
  end if;

  insert into public.bp_blueprints (name, author, description, content, constructions, edges, requires, blueprint_id, version, official, thumbnail_url, categories)
  values (p_name, v_author, nullif(trim(p_description), ''), v_content, coalesce(p_constructions, 0), coalesce(p_edges, 0), p_requires, p_blueprint_id, v_version, v_official, v_thumb, public.bp_categories(v_content))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'version', v_version, 'official', v_official, 'author', v_author, 'thumbnail_url', v_thumb);
end $$;
