-- Blueprint Exchange Library -- live schema on the aijqcrrcreectihaeqoc Supabase
-- project (shared with the PYT Gate Generator), applied as migration
-- "blue_print_library". Kept here for reference/rebuild.
--
-- The blueprint FILES live in the `content` column (the exact text of
-- blueprint_<name>.lua); the page assembles the download from it,
-- so git never stores submitted blueprints. Public read + public
-- insert; bp_download() bumps the counter and returns the text.

create table if not exists public.bp_blueprints (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 60),
  author text check (char_length(author) <= 60),
  description text check (char_length(description) <= 600),
  game text not null default 'tf2',
  content text not null check (char_length(content) between 20 and 4000000),
  constructions int not null default 0,
  edges int not null default 0,
  requires jsonb,
  downloads int not null default 0
);

alter table public.bp_blueprints enable row level security;

create policy "Allow anonymous blueprint reads"
on public.bp_blueprints for select to anon using (true);

create policy "Allow anonymous blueprint uploads"
on public.bp_blueprints for insert to anon with check (true);

create or replace function public.bp_list()
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'created_at', created_at, 'name', name, 'author', author,
    'description', description, 'game', game, 'constructions', constructions,
    'edges', edges, 'requires', requires, 'downloads', downloads,
    'size', char_length(content)
  ) order by created_at desc), '[]'::jsonb)
  from public.bp_blueprints;
$$;
grant execute on function public.bp_list() to anon;

create or replace function public.bp_download(p_id bigint)
returns text language plpgsql security definer set search_path = public as $$
declare v_content text;
begin
  update public.bp_blueprints set downloads = downloads + 1
   where id = p_id returning content into v_content;
  return v_content;
end;
$$;
grant execute on function public.bp_download(bigint) to anon;

-- Moderation (Supabase SQL editor only):
--   delete from public.bp_blueprints where id = <id>;

-- Second migration ("blue_print_library_identity"): blueprint identity.
-- The mod stamps a permanent blueprintId + version into every capture;
-- an upload of an id seen before becomes the next version (bp_next_version),
-- and bp_list() shows only the latest version of each id.
alter table public.bp_blueprints
  add column if not exists blueprint_id text,
  add column if not exists version int not null default 1;

create index if not exists bp_blueprints_blueprint_id_idx on public.bp_blueprints (blueprint_id);

create or replace function public.bp_list()
returns jsonb language sql security definer set search_path = public as $$
  with latest as (
    select distinct on (coalesce(blueprint_id, id::text)) *
    from public.bp_blueprints
    order by coalesce(blueprint_id, id::text), version desc, created_at desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'created_at', created_at, 'name', name, 'author', author,
    'description', description, 'game', game, 'constructions', constructions,
    'edges', edges, 'requires', requires, 'downloads', downloads,
    'size', char_length(content), 'blueprint_id', blueprint_id, 'version', version
  ) order by created_at desc), '[]'::jsonb)
  from latest;
$$;

create or replace function public.bp_next_version(p_blueprint_id text)
returns int language sql security definer set search_path = public as $$
  select coalesce(max(version), 0) + 1 from public.bp_blueprints where blueprint_id = p_blueprint_id;
$$;
grant execute on function public.bp_next_version(text) to anon;

-- Third migration ("blue_print_library_official"): official uploads.
-- A PRIVATE pass-phrase table (RLS on, no policies -- only security-
-- definer functions read it) and bp_upload(), which every upload now
-- goes through: if the author field equals a pass-phrase the row is
-- marked official and the public author becomes that key's display
-- name. The direct anon INSERT policy is dropped (it could have set
-- official = true). Change the pass-phrase in the SQL editor:
--   update public.bp_official_keys set passphrase = '...' where display_name = 'Epod';
alter table public.bp_blueprints add column if not exists official boolean not null default false;
create table if not exists public.bp_official_keys (
  id bigint generated always as identity primary key,
  passphrase text not null,
  display_name text not null
);
alter table public.bp_official_keys enable row level security;
-- bp_upload(p_name, p_author, p_description, p_content, p_constructions, p_edges, p_requires, p_blueprint_id)
--   -> { id, version, official, author }; see the live function for the body.
drop policy if exists "Allow anonymous blueprint uploads" on public.bp_blueprints;
-- bp_list() now also returns `official` and sorts official rows first.

-- Fourth migration ("blue_print_library_thumbnail"): optional preview
-- image. The image itself lives in Cloudflare R2 (bucket
-- blueprint-thumbnails, worker/ in this repo writes it there) -- this
-- table only ever stores the resulting public R2 URL, never image
-- data. bp_upload() now takes a 9th argument, p_thumbnail_url, and
-- only accepts a URL matching this project's own R2 public base +
-- /blueprints/<uuid>.webp -- anything else is silently dropped to
-- null, since this is a security-definer function a caller could in
-- principle call directly. bp_list() returns thumbnail_url (null for
-- every blueprint uploaded before this migration) and now also
-- returns `official` explicitly and sorts official rows first.
--
-- NOTE: `create or replace function` with a DIFFERENT argument list
-- creates a new overload rather than replacing the old one -- the
-- pre-thumbnail 8-argument bp_upload was dropped explicitly so the
-- frontend's named-parameter RPC call resolves to exactly one
-- function. If you ever add another bp_upload parameter, drop the
-- old signature the same way.
alter table public.bp_blueprints
  add column if not exists thumbnail_url text
    check (thumbnail_url is null or char_length(thumbnail_url) <= 300);

drop function if exists public.bp_upload(text, text, text, text, int, int, jsonb, text);

create or replace function public.bp_list()
returns jsonb language sql security definer set search_path = public as $$
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
    'official', official, 'thumbnail_url', thumbnail_url
  ) order by official desc, created_at desc), '[]'::jsonb)
  from latest;
$$;

create or replace function public.bp_upload(
  p_name text, p_author text, p_description text, p_content text,
  p_constructions int, p_edges int, p_requires jsonb, p_blueprint_id text,
  p_thumbnail_url text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_display text;
  v_official boolean := false;
  v_author text := nullif(trim(p_author), '');
  v_version int := 1;
  v_id bigint;
  v_thumb text := nullif(trim(coalesce(p_thumbnail_url, '')), '');
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
  end if;

  insert into public.bp_blueprints (name, author, description, content, constructions, edges, requires, blueprint_id, version, official, thumbnail_url)
  values (p_name, v_author, nullif(trim(p_description), ''), p_content, coalesce(p_constructions, 0), coalesce(p_edges, 0), p_requires, p_blueprint_id, v_version, v_official, v_thumb)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'version', v_version, 'official', v_official, 'author', v_author, 'thumbnail_url', v_thumb);
end;
$$;
grant execute on function public.bp_upload(text, text, text, text, int, int, jsonb, text, text) to anon;

-- Fifth migration ("blue_print_library_owner_secret"): a blueprintId
-- is plain text in the file's own header comment, so anyone could
-- copy it into their own upload and overwrite someone else's card
-- (bp_list only ever shows the latest version of an id). The mod now
-- also writes an ownerSecret into every captured file (never shown in
-- game, never printed in the header). bp_upload takes it as a 10th
-- argument: the FIRST upload of a blueprintId claims it by storing a
-- SHA-256 hash of the secret in bp_blueprint_owners (RLS on, no
-- policies -- only this security-definer function touches it); any
-- later upload of the same id must hash to the same value or the
-- whole upload is rejected with a plain-English error. The raw
-- secret is never returned, never listed, and bp_upload strips any
-- "ownerSecret = ..." field out of the content before it's stored, so
-- it can never ride along into a download even if a client forgot to
-- omit it.
--
-- NOTE: pgcrypto lives in the `extensions` schema on this project --
-- digest() needed `extensions` added to this function's search_path,
-- not just `public`, or it fails with "function digest does not
-- exist".
--
-- Known accepted gap: a player can still hand their personal
-- blueprint_<name>.lua straight to a friend (the mod supports this --
-- see Decision 24), and that file carries the real ownerSecret in the
-- clear, unlike a website download, which never gets it. Low stakes
-- for a small hobby community; revisit only if it's ever actually
-- abused.
create table if not exists public.bp_blueprint_owners (
  blueprint_id text primary key,
  secret_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.bp_blueprint_owners enable row level security;

drop function if exists public.bp_upload(text, text, text, text, int, int, jsonb, text, text);

create or replace function public.bp_upload(
  p_name text, p_author text, p_description text, p_content text,
  p_constructions int, p_edges int, p_requires jsonb, p_blueprint_id text,
  p_thumbnail_url text default null, p_owner_secret text default null
)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
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

  v_content := regexp_replace(v_content, 'ownerSecret\s*=\s*"[^"]*"\s*,?\s*', '', 'g');

  insert into public.bp_blueprints (name, author, description, content, constructions, edges, requires, blueprint_id, version, official, thumbnail_url)
  values (p_name, v_author, nullif(trim(p_description), ''), v_content, coalesce(p_constructions, 0), coalesce(p_edges, 0), p_requires, p_blueprint_id, v_version, v_official, v_thumb)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'version', v_version, 'official', v_official, 'author', v_author, 'thumbnail_url', v_thumb);
end;
$$;
grant execute on function public.bp_upload(text, text, text, text, int, int, jsonb, text, text, text) to anon;

-- Sixth migration ("blue_print_library_visitors"): unique visitor
-- count with real day-by-day history, not just a running total. The
-- "visitor" is a random id the page generates once and keeps in
-- localStorage -- no IP, no real identity, nothing PII. Two tables:
-- bp_visits (one row per visitor id ever seen -- the all-time unique
-- count) and bp_visit_days (one row per visitor per calendar day, so
-- unique-visitors-per-day can be charted later). Both write-only from
-- the anon side through bp_track_visit, a single security-definer
-- function -- no direct table access granted, and it validates the
-- visitor id's shape before touching a row.
--
-- NOTE (caught testing): supabase-js's rpc() builder doesn't expose a
-- bare .catch() the way a real Promise does -- wrap it in try/await,
-- not .then/.catch chaining, or errors go uncaught silently wrong.
create table if not exists public.bp_visits (
  visitor_id text primary key,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  visit_count int not null default 1
);
alter table public.bp_visits enable row level security;

create table if not exists public.bp_visit_days (
  day date not null,
  visitor_id text not null,
  primary key (day, visitor_id)
);
alter table public.bp_visit_days enable row level security;
create index if not exists bp_visit_days_day_idx on public.bp_visit_days (day);

create or replace function public.bp_track_visit(p_visitor_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_visitor_id is null or p_visitor_id !~ '^[a-zA-Z0-9_-]{8,64}$' then
    return;
  end if;

  insert into public.bp_visits (visitor_id) values (p_visitor_id)
  on conflict (visitor_id) do update
    set last_seen = now(), visit_count = bp_visits.visit_count + 1;

  insert into public.bp_visit_days (day, visitor_id) values (current_date, p_visitor_id)
  on conflict (day, visitor_id) do nothing;
end;
$$;
grant execute on function public.bp_track_visit(text) to anon;

create or replace function public.bp_visit_stats()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'total_unique', (select count(*) from public.bp_visits),
    'last_30_days', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'unique_visitors', cnt) order by day)
      from (
        select day, count(*) as cnt
        from public.bp_visit_days
        where day > current_date - interval '30 days'
        group by day
      ) d
    ), '[]'::jsonb)
  );
$$;
grant execute on function public.bp_visit_stats() to anon;

-- Later migrations (see the live project / README for the bodies):
--   owner_secret  -- bp_blueprint_owners: ownership proof for updating a blueprint
--   visitors      -- bp_visits, bp_visit_days, bp_track_visit(), bp_visit_stats()
--   plug_my_mod   -- pm_mods (one row per listed Workshop item; canonical-URL CHECK),
--                    pm_rate_events (salted IP hashes only), pm_secrets (ip_salt),
--                    pm_list() security-definer read granted to anon, and the public
--                    Storage bucket `plug-my-mod` (3 MB, jpeg/png/gif/webp) holding the
--                    cached Steam preview images. All tables: RLS on, no policies.
--                    Written to only by the `plug-my-mod` Edge Function
--                    (supabase/functions/plug-my-mod/index.ts).
-- Moderation for Plug My Mod:
--   update public.pm_mods set status = 'hidden' where workshop_id = <id>;

--   bp_ownership  -- see supabase/migrations/bp_ownership.sql: bp_browser_access (hashed
--                    browser tokens), bp_recovery_attempts, bp_claim_browser(),
--                    bp_my_blueprints(), bp_edit(), bp_revoke_browser(), and bp_upload()
--                    now verifies the public copy carries no ownership data.
--   bp_categories -- see supabase/migrations/bp_categories.sql: bp_blueprints.categories, bp_categories(), bp_list()/bp_upload() updated.
