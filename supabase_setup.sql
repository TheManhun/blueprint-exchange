-- Blue Print Library -- live schema on the aijqcrrcreectihaeqoc Supabase
-- project (shared with the PYT Gate Generator), applied as migration
-- "blue_print_library". Kept here for reference/rebuild.
--
-- The blueprint FILES live in the `content` column (the exact text of
-- blue_print_bp_<name>.lua); the page assembles the download from it,
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
