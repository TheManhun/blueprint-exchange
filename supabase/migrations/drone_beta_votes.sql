-- tfbpx.com "PYT - Drone 2020 BETA: tune it together" (Epod, 2026-10-08: 'a page dedicated to the Drone Beta and a
-- voting panel -- they see results at the end, how what's your default setting -- keep the data on Supabase').
-- Project aijqcrrcreectihaeqoc. The same safety pattern as bp_reports:
--   * the table has RLS on and NO policies: the site cannot read or write rows directly
--   * one vote per visitor (bp_caller_hash, the site's visitor fingerprint): voting again REPLACES your vote
--   * every answer must be one of the in-game choices (Tune your drone empire, pyt_drone_page.lua ROWS) -- nothing else
--     is stored; the comment is optional, 500 characters at most
--   * the results function returns only the counts per choice, never a row

create table if not exists public.drone_beta_votes (
    id          bigserial primary key,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    caller_hash text not null unique,
    speed       text not null check (speed in ('125', '188', '250', '313', '375')),
    noise       text not null check (noise in ('whisper', 'quiet', 'busy', 'fullrotor')),
    pollution   text not null check (pollution in ('zero', 'electric', 'some', 'full')),
    range_km    text not null check (range_km in ('2', '5', '10', '20', 'unlimited')),
    over_range  text not null check (over_range in ('quarter', 'third', 'half', 'none')),
    maint_rule  text not null check (maint_rule in ('grows', 'same')),
    load_rule   text not null check (load_rule in ('grows', 'same', 'none')),
    crew_top    text not null check (crew_top in ('x3', 'x4')),
    comment     text check (char_length(comment) <= 500)
);

alter table public.drone_beta_votes enable row level security;   -- and no policies
revoke all on public.drone_beta_votes from anon, authenticated;

-- the counts per question and choice, plus the total -- what the page shows after a vote
create or replace function public.drone_beta_results()
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
    select jsonb_build_object(
        'total', (select count(*) from public.drone_beta_votes),
        'speed',      (select coalesce(jsonb_object_agg(speed, n), '{}'::jsonb)      from (select speed, count(*) n from public.drone_beta_votes group by speed) t),
        'noise',      (select coalesce(jsonb_object_agg(noise, n), '{}'::jsonb)      from (select noise, count(*) n from public.drone_beta_votes group by noise) t),
        'pollution',  (select coalesce(jsonb_object_agg(pollution, n), '{}'::jsonb)  from (select pollution, count(*) n from public.drone_beta_votes group by pollution) t),
        'range_km',   (select coalesce(jsonb_object_agg(range_km, n), '{}'::jsonb)   from (select range_km, count(*) n from public.drone_beta_votes group by range_km) t),
        'over_range', (select coalesce(jsonb_object_agg(over_range, n), '{}'::jsonb) from (select over_range, count(*) n from public.drone_beta_votes group by over_range) t),
        'maint_rule', (select coalesce(jsonb_object_agg(maint_rule, n), '{}'::jsonb) from (select maint_rule, count(*) n from public.drone_beta_votes group by maint_rule) t),
        'load_rule',  (select coalesce(jsonb_object_agg(load_rule, n), '{}'::jsonb)  from (select load_rule, count(*) n from public.drone_beta_votes group by load_rule) t),
        'crew_top',   (select coalesce(jsonb_object_agg(crew_top, n), '{}'::jsonb)   from (select crew_top, count(*) n from public.drone_beta_votes group by crew_top) t)
    )
$function$;

-- a vote (or a changed vote): checks every answer, keeps one row per visitor, returns the results
create or replace function public.drone_beta_vote(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
    ch text := public.bp_caller_hash();
    v_comment text := nullif(trim(coalesce(p->>'comment', '')), '');
begin
    if char_length(coalesce(v_comment, '')) > 500 then
        return jsonb_build_object('ok', false, 'error', 'Please keep the comment under 500 characters.');
    end if;
    begin
        insert into public.drone_beta_votes (caller_hash, speed, noise, pollution, range_km, over_range, maint_rule, load_rule, crew_top, comment)
        values (ch, p->>'speed', p->>'noise', p->>'pollution', p->>'range_km', p->>'over_range', p->>'maint_rule', p->>'load_rule', p->>'crew_top', v_comment)
        on conflict (caller_hash) do update set
            speed = excluded.speed, noise = excluded.noise, pollution = excluded.pollution, range_km = excluded.range_km,
            over_range = excluded.over_range, maint_rule = excluded.maint_rule, load_rule = excluded.load_rule,
            crew_top = excluded.crew_top, comment = excluded.comment, updated_at = now();
    exception when check_violation or not_null_violation then
        return jsonb_build_object('ok', false, 'error', 'Please pick one answer for every question.');
    end;
    return jsonb_build_object('ok', true, 'results', public.drone_beta_results());
end
$function$;

revoke all on function public.drone_beta_vote(jsonb) from public;
revoke all on function public.drone_beta_results() from public;
grant execute on function public.drone_beta_vote(jsonb) to anon, authenticated;
grant execute on function public.drone_beta_results() to anon, authenticated;

-- Reading the votes (dashboard / SQL editor):
--   select public.drone_beta_results();
--   select created_at, updated_at, speed, noise, pollution, range_km, over_range, maint_rule, load_rule, crew_top, comment
--   from public.drone_beta_votes order by updated_at desc;
