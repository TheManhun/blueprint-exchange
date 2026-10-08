-- tfbpx.com: PYT beta tester sign-up (Epod, 2026-10-08: 'they could add an email to volunteer to be a PYT beta
-- tester'), on the drone vote page. Project aijqcrrcreectihaeqoc. Personal data, so:
--   * RLS on, NO policies, no read function: the site can never read the list -- only Epod, in the dashboard
--   * consent is required (the page's checkbox); the page promises: only used to invite you to PYT beta tests, deleted
--     on request
--   * one row per email (lower-cased): signing up again updates the games / note
--   * 5 sign-ups per hour per visitor (bp_caller_hash), sizes capped, a basic email shape check

create table if not exists public.pyt_beta_testers (
    id          bigserial primary key,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    email       text not null unique check (char_length(email) between 6 and 254),
    games       text not null check (games in ('tf2', 'tf3', 'both')),
    note        text check (char_length(note) <= 300),
    source      text check (char_length(source) <= 40),
    consent     boolean not null check (consent),
    caller_hash text
);

alter table public.pyt_beta_testers enable row level security;   -- and no policies
revoke all on public.pyt_beta_testers from anon, authenticated;

create or replace function public.pyt_beta_signup(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
    ch text := public.bp_caller_hash();
    v_email text := lower(trim(coalesce(p->>'email', '')));
    v_games text := coalesce(p->>'games', '');
    v_note text := nullif(trim(coalesce(p->>'note', '')), '');
    v_recent int;
begin
    if coalesce((p->>'consent')::boolean, false) is not true then
        return jsonb_build_object('ok', false, 'error', 'Please tick the box so we may email you about beta tests.');
    end if;
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
        return jsonb_build_object('ok', false, 'error', 'That email address doesn''t look right.');
    end if;
    if v_games not in ('tf2', 'tf3', 'both') then
        return jsonb_build_object('ok', false, 'error', 'Please pick which game you play.');
    end if;
    if char_length(coalesce(v_note, '')) > 300 then
        return jsonb_build_object('ok', false, 'error', 'Please keep the note under 300 characters.');
    end if;
    select count(*) into v_recent from public.pyt_beta_testers where caller_hash = ch and updated_at > now() - interval '1 hour';
    if v_recent >= 5 then
        return jsonb_build_object('ok', false, 'error', 'Thanks -- that''s enough sign-ups for now. Please try again later.');
    end if;
    insert into public.pyt_beta_testers (email, games, note, source, consent, caller_hash)
    values (v_email, v_games, v_note, left(coalesce(p->>'source', ''), 40), true, ch)
    on conflict (email) do update set games = excluded.games, note = excluded.note, source = excluded.source,
        caller_hash = excluded.caller_hash, updated_at = now();
    return jsonb_build_object('ok', true);
end
$function$;

revoke all on function public.pyt_beta_signup(jsonb) from public;
grant execute on function public.pyt_beta_signup(jsonb) to anon, authenticated;

-- Reading the list (dashboard / SQL editor -- Epod only):
--   select created_at, email, games, note, source from public.pyt_beta_testers order by created_at desc;
-- Deleting someone on request:
--   delete from public.pyt_beta_testers where email = lower('their@email');
