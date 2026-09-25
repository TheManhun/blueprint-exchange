-- Migrations "bp_dependencies_schema" + "bp_base_resources_seed" (see
-- bp_base_resources_seed.sql) + "bp_dependencies_wiring", applied 25 Sep 2026.
-- Mod dependency resolution: which Workshop mod supplies which resource path.

create table if not exists public.bp_base_resources (
  resource_type text not null,
  resource_path text not null,
  primary key (resource_type, resource_path)
);
alter table public.bp_base_resources enable row level security;

create table if not exists public.bp_mod_resources (
  id            bigserial primary key,
  game          text not null default 'tf2',
  resource_path text not null check (char_length(resource_path) between 1 and 200 and resource_path ~ '^[A-Za-z0-9_./ -]+$'),
  resource_type text not null check (resource_type in ('construction','track','street','bridge','model','tunnel','signal','module','asset')),
  workshop_id   bigint not null check (workshop_id > 0),
  mod_name      text not null check (char_length(mod_name) between 1 and 200),
  steam_url     text not null,
  preview_url   text,
  verified      boolean not null default false,
  source        text not null check (source in ('scan','manual')),
  confirmations integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint bp_mod_resources_url_canonical check (steam_url = 'https://steamcommunity.com/sharedfiles/filedetails/?id=' || workshop_id::text),
  constraint bp_mod_resources_unique unique (game, resource_type, resource_path, workshop_id)
);
create index if not exists bp_mod_resources_lookup on public.bp_mod_resources (game, resource_type, resource_path);
alter table public.bp_mod_resources enable row level security;

create table if not exists public.bp_mod_confirmers (
  mapping_id bigint not null references public.bp_mod_resources(id) on delete cascade,
  ip_hash    text not null,
  primary key (mapping_id, ip_hash)
);
alter table public.bp_mod_confirmers enable row level security;

alter table public.pm_rate_events drop constraint if exists pm_rate_events_kind_check;
alter table public.pm_rate_events add constraint pm_rate_events_kind_check check (kind in ('lookup','submit','link'));

-- every group of a blueprint's requires block, read from the file's text
create or replace function public.bp_requires_group(p_content text, p_group text)
returns jsonb language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(m[1]), '[]'::jsonb)
  from regexp_matches(
    coalesce(substring(p_content from 'requires = \{(?:\w+ = \{[^{}]*\}, )*' || p_group || ' = \{([^}]*)\}'), ''),
    '"([^"]+)"', 'g') m;
$$;

create or replace function public.bp_requires(p_content text)
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'constructions', public.bp_requires_group(p_content, 'constructions'),
    'tracks',        public.bp_requires_group(p_content, 'tracks'),
    'streets',       public.bp_requires_group(p_content, 'streets'),
    'bridges',       public.bp_requires_group(p_content, 'bridges'),
    'tunnels',       public.bp_requires_group(p_content, 'tunnels'),
    'models',        public.bp_requires_group(p_content, 'models'));
$$;
grant execute on function public.bp_requires(text) to anon, authenticated;
grant execute on function public.bp_requires_group(text, text) to anon, authenticated;

-- base / mod / unknown for every path in a requires object
create or replace function public.bp_dependency_report(p_requires jsonb)
returns jsonb language sql stable security definer
set search_path = public as $$
  with items as (
    select g.type, p.path
      from (values ('constructions','construction'),('tracks','track'),('streets','street'),
                   ('bridges','bridge'),('tunnels','tunnel'),('models','model')) g(grp, type)
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(coalesce(p_requires -> g.grp, '[]'::jsonb)) = 'array' then coalesce(p_requires -> g.grp, '[]'::jsonb) else '[]'::jsonb end) as p(path)
     limit 400
  ), classified as (
    select i.type, i.path,
      case
        when (i.type = 'construction' and i.path ~ '^building/')
          or exists (select 1 from public.bp_base_resources b where b.resource_type = i.type and b.resource_path = i.path) then 'base'
        when exists (select 1 from public.bp_mod_resources m where m.game = 'tf2' and m.resource_type = i.type and m.resource_path = i.path) then 'mod'
        else 'unknown' end as status
    from items i
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'type', c.type, 'path', c.path, 'status', c.status,
    'mod', (select jsonb_build_object('workshop_id', m.workshop_id::text, 'name', m.mod_name,
                                      'steam_url', m.steam_url, 'preview_url', m.preview_url, 'verified', m.verified)
              from public.bp_mod_resources m
             where c.status = 'mod' and m.game = 'tf2' and m.resource_type = c.type and m.resource_path = c.path
             order by m.confirmations desc, m.created_at asc limit 1))), '[]'::jsonb)
  from classified c;
$$;
grant execute on function public.bp_dependency_report(jsonb) to anon, authenticated;

-- teach BPX: only the Edge Function (service role) may call this
create or replace function public.bp_link_mod(
  p_ip_hash text, p_workshop_id bigint, p_mod_name text, p_preview_url text, p_source text, p_resources jsonb)
returns integer language plpgsql security definer
set search_path = public as $$
declare
  r record; v_id bigint; v_n int := 0; v_rc int;
begin
  if p_source not in ('scan','manual') or p_workshop_id is null or p_workshop_id <= 0 then return 0; end if;
  for r in select * from jsonb_to_recordset(p_resources) as x(type text, path text) limit 100 loop
    continue when r.type is null or r.path is null;
    continue when r.type not in ('construction','track','street','bridge','model','tunnel');
    continue when r.path !~ '^[A-Za-z0-9_./ -]{1,200}$';
    continue when (r.type = 'construction' and r.path ~ '^building/')
               or exists (select 1 from public.bp_base_resources b where b.resource_type = r.type and b.resource_path = r.path);
    insert into public.bp_mod_resources (resource_path, resource_type, workshop_id, mod_name, steam_url, preview_url, source)
    values (r.path, r.type, p_workshop_id, left(p_mod_name, 200),
            'https://steamcommunity.com/sharedfiles/filedetails/?id=' || p_workshop_id::text, p_preview_url, p_source)
    on conflict (game, resource_type, resource_path, workshop_id)
      do update set mod_name = excluded.mod_name, preview_url = coalesce(excluded.preview_url, public.bp_mod_resources.preview_url), updated_at = now()
    returning id into v_id;
    insert into public.bp_mod_confirmers (mapping_id, ip_hash) values (v_id, p_ip_hash) on conflict do nothing;
    get diagnostics v_rc = row_count;
    if v_rc > 0 then
      update public.bp_mod_resources set confirmations = confirmations + 1, verified = (confirmations + 1) >= 2 where id = v_id;
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.bp_link_mod(text, bigint, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.bp_link_mod(text, bigint, text, text, text, jsonb) to service_role;

-- "wiring": every requires group stored for existing blueprints; bp_list returns
-- `mods` and `unresolved`; bp_upload reads requires from the file and refuses
-- unidentified external content. (bp_list / bp_upload bodies: see the live
-- functions -- they extend the versions in bp_ownership.sql / bp_categories.sql
-- with the dependency check:
--   v_requires := public.bp_requires(v_content);
--   if exists (select 1 from jsonb_array_elements(public.bp_dependency_report(v_requires)) x
--               where x ->> 'status' = 'unknown') then
--     raise exception 'This blueprint uses external mod content BPX cannot yet identify. ...';
--   end if;)
update public.bp_blueprints set requires = public.bp_requires(content)
 where requires is distinct from public.bp_requires(content);
