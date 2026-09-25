-- Migration "bp_ownership": account-free ownership + editing.
--
-- Model: the original blueprint file carries a private ownerSecret (the
-- mod generates it). The library only ever stores its SHA-256 hash
-- (bp_blueprint_owners, from an earlier migration) and strips it from the
-- public copy. A browser that has proven it holds the file gets a random
-- token; only the token's hash is stored here, tied to the blueprints it
-- may manage. Everything is checked inside these security-definer
-- functions; the tables have RLS on and no policies.

create table if not exists public.bp_browser_access (
  token_hash   text        not null,
  blueprint_id text        not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  revoked_at   timestamptz,
  primary key (token_hash, blueprint_id)
);
alter table public.bp_browser_access enable row level security;

create table if not exists public.bp_recovery_attempts (
  id      bigserial primary key,
  ip_hash text        not null,
  at      timestamptz not null default now()
);
create index if not exists bp_recovery_attempts_ip_at on public.bp_recovery_attempts (ip_hash, at);
alter table public.bp_recovery_attempts enable row level security;

-- ---------- internal helpers (not callable from the browser) ----------

create or replace function public.bp_token_hash(p_token text)
returns text language sql immutable security definer
set search_path = public, extensions as $$
  select case when p_token ~ '^[0-9a-f]{32,128}$'
              then encode(extensions.digest(p_token, 'sha256'), 'hex') end;
$$;

-- Salted hash of the caller's address (never the address itself), from the
-- headers PostgREST hands to the function. Same salt as Plug My Mod.
create or replace function public.bp_caller_hash()
returns text language plpgsql security definer
set search_path = public, extensions as $$
declare h json; ip text; salt text;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then h := null; end;
  ip := trim(split_part(coalesce(h->>'cf-connecting-ip', h->>'x-forwarded-for', ''), ',', 1));
  if ip = '' then ip := 'unknown'; end if;
  select value into salt from public.pm_secrets where name = 'ip_salt';
  return encode(extensions.digest(coalesce(salt, '') || ':bpx:' || ip, 'sha256'), 'hex');
end $$;

revoke all on function public.bp_token_hash(text) from public, anon, authenticated;
revoke all on function public.bp_caller_hash() from public, anon, authenticated;

-- ---------- prove ownership, authorise this browser ----------
-- Returns {ok:true,...} or {ok:false}; a wrong file never says which part
-- was wrong. {ok:false,code:'unclaimed'} means no ownership key is on
-- record at all for that blueprint (older uploads), {code:'rate_limited'}
-- means too many wrong tries from this address.
create or replace function public.bp_claim_browser(p_token text, p_blueprint_id text, p_owner_secret text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  th text := public.bp_token_hash(p_token);
  ch text;
  v_secret text := nullif(trim(coalesce(p_owner_secret, '')), '');
  v_hash text;
  v_recent int;
  v_row record;
begin
  if th is null or p_blueprint_id is null or length(p_blueprint_id) > 100
     or v_secret is null or length(v_secret) > 200 then
    return jsonb_build_object('ok', false);
  end if;

  ch := public.bp_caller_hash();
  if random() < 0.05 then
    delete from public.bp_recovery_attempts where at < now() - interval '2 days';
  end if;
  select count(*) into v_recent from public.bp_recovery_attempts where ip_hash = ch and at > now() - interval '1 hour';
  if v_recent >= 20 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;

  select secret_hash into v_hash from public.bp_blueprint_owners where blueprint_id = p_blueprint_id;
  if v_hash is null then
    return jsonb_build_object('ok', false, 'code', 'unclaimed');
  end if;

  if encode(extensions.digest(v_secret, 'sha256'), 'hex') <> v_hash then
    insert into public.bp_recovery_attempts (ip_hash) values (ch);
    return jsonb_build_object('ok', false);
  end if;

  insert into public.bp_browser_access (token_hash, blueprint_id)
  values (th, p_blueprint_id)
  on conflict (token_hash, blueprint_id) do update set revoked_at = null, last_used_at = now();

  select id, name, version into v_row from public.bp_blueprints
   where blueprint_id = p_blueprint_id order by version desc, created_at desc limit 1;
  return jsonb_build_object('ok', true, 'blueprint_id', p_blueprint_id, 'name', v_row.name, 'version', v_row.version);
end $$;

-- ---------- what may this browser manage? ----------
create or replace function public.bp_my_blueprints(p_token text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare th text := public.bp_token_hash(p_token); v jsonb;
begin
  if th is null then return '[]'::jsonb; end if;
  update public.bp_browser_access set last_used_at = now()
   where token_hash = th and revoked_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'blueprint_id', l.blueprint_id, 'name', l.name, 'description', l.description,
      'thumbnail_url', l.thumbnail_url, 'version', l.version, 'downloads', l.downloads,
      'author', l.author, 'official', l.official) order by l.created_at desc), '[]'::jsonb)
    into v
    from (
      select distinct on (b.blueprint_id) b.*
        from public.bp_blueprints b
        join public.bp_browser_access a on a.blueprint_id = b.blueprint_id
       where a.token_hash = th and a.revoked_at is null
       order by b.blueprint_id, b.version desc, b.created_at desc
    ) l;
  return v;
end $$;

-- ---------- edit the public metadata of a blueprint this browser owns ----------
-- Only name, description and thumbnail. Not the id, owner hash, downloads,
-- author (the Official pass-phrase lives there), version history, or file.
create or replace function public.bp_edit(
  p_token text, p_blueprint_id text, p_name text, p_description text,
  p_thumbnail_url text default null, p_set_thumbnail boolean default false)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  th text := public.bp_token_hash(p_token);
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_desc text := nullif(trim(coalesce(p_description, '')), '');
  v_thumb text := nullif(trim(coalesce(p_thumbnail_url, '')), '');
  v_id bigint;
begin
  if th is null or not exists (
       select 1 from public.bp_browser_access
        where token_hash = th and blueprint_id = p_blueprint_id and revoked_at is null) then
    return jsonb_build_object('ok', false, 'code', 'not_authorised');
  end if;
  if v_name is null or char_length(v_name) > 60 then
    return jsonb_build_object('ok', false, 'code', 'bad_name');
  end if;
  if v_desc is not null and char_length(v_desc) > 600 then
    return jsonb_build_object('ok', false, 'code', 'bad_description');
  end if;
  if coalesce(p_set_thumbnail, false)
     and (v_thumb is null or v_thumb !~ '^https://pub-ea55f87d66c04139a2a7ac3704e9c05e\.r2\.dev/blueprints/[a-zA-Z0-9-]+\.webp$') then
    return jsonb_build_object('ok', false, 'code', 'bad_thumbnail');
  end if;

  select id into v_id from public.bp_blueprints
   where blueprint_id = p_blueprint_id order by version desc, created_at desc limit 1;
  if v_id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;

  update public.bp_blueprints
     set name = v_name,
         description = v_desc,
         thumbnail_url = case when coalesce(p_set_thumbnail, false) then v_thumb else thumbnail_url end
   where id = v_id;
  update public.bp_browser_access set last_used_at = now() where token_hash = th and blueprint_id = p_blueprint_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- stop this browser managing things (never deletes anything) ----------
create or replace function public.bp_revoke_browser(p_token text, p_blueprint_id text default null)
returns integer language plpgsql security definer
set search_path = public, extensions as $$
declare th text := public.bp_token_hash(p_token); n int;
begin
  if th is null then return 0; end if;
  update public.bp_browser_access set revoked_at = now()
   where token_hash = th and revoked_at is null
     and (p_blueprint_id is null or blueprint_id = p_blueprint_id);
  get diagnostics n = row_count;
  return n;
end $$;

grant execute on function public.bp_claim_browser(text, text, text) to anon, authenticated;
grant execute on function public.bp_my_blueprints(text) to anon, authenticated;
grant execute on function public.bp_edit(text, text, text, text, text, boolean) to anon, authenticated;
grant execute on function public.bp_revoke_browser(text, text) to anon, authenticated;

-- ---------- bp_upload: explicit public-copy sanitisation ----------
-- Same argument list as before (create or replace, so no overload). The
-- ownership key is removed by name, then the result is CHECKED: if any
-- ownership field name or the secret's own value is still in the text the
-- upload is refused rather than published.
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

  -- The public copy: strip every ownership / edit / recovery field ...
  v_content := regexp_replace(v_content,
    '\m(ownerSecret|ownerKey|owner_key|editKey|recoveryToken|browserToken)\s*=\s*"[^"]*"\s*,?\s*', '', 'g');
  -- ... then verify, instead of assuming.
  if v_content ~* '(ownersecret|ownerkey|owner_key|editkey|recoverytoken|browsertoken)'
     or (v_secret is not null and char_length(v_secret) >= 16 and position(v_secret in v_content) > 0) then
    raise exception 'This file still contains ownership data that cannot be published. Upload the file exactly as the mod saved it.';
  end if;

  insert into public.bp_blueprints (name, author, description, content, constructions, edges, requires, blueprint_id, version, official, thumbnail_url)
  values (p_name, v_author, nullif(trim(p_description), ''), v_content, coalesce(p_constructions, 0), coalesce(p_edges, 0), p_requires, p_blueprint_id, v_version, v_official, v_thumb)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'version', v_version, 'official', v_official, 'author', v_author, 'thumbnail_url', v_thumb);
end $$;
