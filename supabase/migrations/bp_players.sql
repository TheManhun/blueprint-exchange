-- Blueprint Manager players (Epod, 2026-09-29: 'it will also be the key to log them in auto, so we can see
-- their download history -- use Supabase to store users and record their downloads').
--
-- No accounts, no names, no email, no Steam id. The manager page makes a random key, saves it as a file in the
-- player's blueprint folder (bpx_player_key.txt) and only ever sends it to these functions; the database keeps
-- its SHA-256 (bp_token_hash, the same rule the Edit tokens use). Granting the folder = signed in.
-- What is kept per player: when they first / last came, and which library blueprints they downloaded (first,
-- last, how many times). 'Forget me' on the page deletes the player and every download row.
--
-- The tables have RLS on and no policies: nothing reads or writes them except the security-definer functions.
--
-- APPLY: paste into the Supabase SQL editor (project aijqcrrcreectihaeqoc). Additive: no existing object changes.

create table if not exists public.bp_players (
  id         bigint generated always as identity primary key,
  key_hash   text not null unique,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

create table if not exists public.bp_player_downloads (
  player_id    bigint not null references public.bp_players(id) on delete cascade,
  blueprint_id bigint not null references public.bp_blueprints(id) on delete cascade,
  first_at     timestamptz not null default now(),
  last_at      timestamptz not null default now(),
  times        integer not null default 1,
  primary key (player_id, blueprint_id)
);
create index if not exists bp_player_downloads_blueprint on public.bp_player_downloads (blueprint_id);

-- new players per caller (hashed IP) per hour -- stops a script filling the table
create table if not exists public.bp_player_rate (
  ip_hash text not null,
  at      timestamptz not null default now()
);
create index if not exists bp_player_rate_ip_at on public.bp_player_rate (ip_hash, at);

alter table public.bp_players          enable row level security;
alter table public.bp_player_downloads enable row level security;
alter table public.bp_player_rate      enable row level security;
revoke all on public.bp_players, public.bp_player_downloads, public.bp_player_rate from anon, authenticated;


-- Sign in (or sign up on the first visit). Returns {ok, new, downloads} or {ok:false, reason}.
create or replace function public.bp_player_hello(p_key text)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_hash text := public.bp_token_hash(p_key);
  v_id   bigint;
  v_ip   text;
begin
  if v_hash is null then
    return jsonb_build_object('ok', false, 'reason', 'bad key');
  end if;
  update public.bp_players set last_seen = now() where key_hash = v_hash returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('ok', true, 'new', false,
      'downloads', (select count(*) from public.bp_player_downloads where player_id = v_id));
  end if;
  v_ip := public.bp_caller_hash();
  delete from public.bp_player_rate where at < now() - interval '1 day';
  if (select count(*) from public.bp_player_rate where ip_hash = v_ip and at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'too many new players from here -- try again in an hour');
  end if;
  insert into public.bp_player_rate (ip_hash) values (v_ip);
  insert into public.bp_players (key_hash) values (v_hash)
    on conflict (key_hash) do update set last_seen = now()
    returning id into v_id;
  return jsonb_build_object('ok', true, 'new', true, 'downloads', 0);
end $$;


-- A download from the library by a signed-in player: bp_download (count + content) plus the history row.
-- An unknown key still downloads -- it just isn't recorded.
create or replace function public.bp_player_download(p_key text, p_id bigint)
returns text language plpgsql security definer
set search_path = public as $$
declare
  v_content text;
  v_player  bigint;
begin
  v_content := public.bp_download(p_id);
  if v_content is null then
    return null;
  end if;
  select id into v_player from public.bp_players where key_hash = public.bp_token_hash(p_key);
  if v_player is not null then
    update public.bp_players set last_seen = now() where id = v_player;
    insert into public.bp_player_downloads (player_id, blueprint_id) values (v_player, p_id)
      on conflict (player_id, blueprint_id)
      do update set last_at = now(), times = public.bp_player_downloads.times + 1;
  end if;
  return v_content;
end $$;


-- The player's own history, newest first, with each blueprint's current name and version.
create or replace function public.bp_player_history(p_key text)
returns table (blueprint_id bigint, bpx_id text, name text, author text, version integer,
               first_at timestamptz, last_at timestamptz, times integer)
language sql stable security definer
set search_path = public as $$
  select d.blueprint_id, b.blueprint_id, b.name, b.author, b.version, d.first_at, d.last_at, d.times
    from public.bp_players p
    join public.bp_player_downloads d on d.player_id = p.id
    join public.bp_blueprints b on b.id = d.blueprint_id
   where p.key_hash = public.bp_token_hash(p_key)
   order by d.last_at desc
   limit 500;
$$;


-- 'Forget me': the player and every download row go. True if there was anything to delete.
create or replace function public.bp_player_forget(p_key text)
returns boolean language plpgsql security definer
set search_path = public as $$
declare
  v_n integer;
begin
  delete from public.bp_players where key_hash = public.bp_token_hash(p_key);
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;


revoke all on function public.bp_player_hello(text), public.bp_player_download(text, bigint),
                       public.bp_player_history(text), public.bp_player_forget(text) from public;
grant execute on function public.bp_player_hello(text), public.bp_player_download(text, bigint),
                          public.bp_player_history(text), public.bp_player_forget(text) to anon, authenticated;
