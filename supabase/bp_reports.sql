-- APPLIED 2026-09-30 (migrations bp_reports_report_a_problem + bp_reports_drop_nul_check).
-- tfbpx.com "Report a problem" (Epod, 2026-09-30: 'can we add an upload-your-reports page ... only allows lua and
-- txt ... maybe a scan to make sure it's not a virus'). Run once in the Supabase SQL editor (project aijqcrrcreectihaeqoc).
--
-- Safety, by design rather than by a virus scanner:
--   * only TEXT is stored -- a log (.txt) and a blueprint (.lua) -- in database columns, never as files anyone can
--     download or run; anything with a NUL byte (binary) is refused, sizes are capped
--   * a blueprint must look like a Blueprint Exchange file (a 'return {' table with 'blueprint = 1') and must not
--     contain code words (function / require / io. / os. / load ...) -- the same rule the upload page uses
--   * its private edit key (ownerSecret) is cut out before it is stored (the page cuts it too)
--   * nobody can read the table from the site: no read policy, no read function -- only Epod, in the dashboard
--   * 5 reports per hour per visitor (the same visitor fingerprint the site already uses)

create table if not exists public.bp_reports (
    id            bigserial primary key,
    created_at    timestamptz not null default now(),
    name          text check (char_length(name) <= 80),
    contact       text check (char_length(contact) <= 200),
    message       text not null check (char_length(message) between 5 and 4000),
    game_version  text check (char_length(game_version) <= 40),
    log_text      text check (char_length(log_text) <= 600000),
    blueprint_text text check (char_length(blueprint_text) <= 4000000),
    caller_hash   text,
    status        text not null default 'new' check (status in ('new', 'seen', 'fixed', 'closed'))
);

alter table public.bp_reports enable row level security;   -- and no policies: the site cannot read or write it directly
revoke all on public.bp_reports from anon, authenticated;

create or replace function public.bp_report_submit(p_name text, p_contact text, p_message text, p_game_version text,
                                                   p_log text, p_blueprint text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
    ch text := public.bp_caller_hash();
    v_recent int;
    v_blueprint text := nullif(p_blueprint, '');
    v_log text := nullif(p_log, '');
    v_id bigint;
begin
    if p_message is null or char_length(trim(p_message)) < 5 then
        return jsonb_build_object('ok', false, 'error', 'Please say what happened (a sentence is enough).');
    end if;
    select count(*) into v_recent from public.bp_reports where caller_hash = ch and created_at > now() - interval '1 hour';
    if v_recent >= 5 then
        return jsonb_build_object('ok', false, 'error', 'Thanks -- that is 5 reports this hour. Please try again later.');
    end if;
    -- (no NUL check: Postgres text cannot hold a NUL byte at all, and chr(0) itself is refused -- live, 2026-09-30)
    if char_length(coalesce(v_log, '')) > 600000 or char_length(coalesce(v_blueprint, '')) > 4000000 then
        return jsonb_build_object('ok', false, 'error', 'A file is too big (log 600 KB, blueprint 4 MB at most).');
    end if;
    if v_blueprint is not null then
        if v_blueprint !~ '^\s*(--[^\n]*\n\s*)*return\s*\{' or v_blueprint !~ '\mblueprint\s*=\s*1\M' then
            return jsonb_build_object('ok', false, 'error', 'That blueprint file is not a Blueprint Exchange file.');
        end if;
        -- code words outside quoted text (names may say 'load' or 'function')
        if regexp_replace(v_blueprint, '"([^"\\\n]|\\.)*"', '""', 'g') ~ '\m(function|require|dofile|load)\M|\m(io|os|game|api)\.' then
            return jsonb_build_object('ok', false, 'error', 'That blueprint file contains code, not just layout data.');
        end if;
        v_blueprint := regexp_replace(v_blueprint, 'ownerSecret\s*=\s*"[^"]*"\s*,?', '', 'g');   -- never keep the edit key
    end if;
    insert into public.bp_reports (name, contact, message, game_version, log_text, blueprint_text, caller_hash)
    values (nullif(trim(p_name), ''), nullif(trim(p_contact), ''), trim(p_message), nullif(trim(p_game_version), ''), v_log, v_blueprint, ch)
    returning id into v_id;
    return jsonb_build_object('ok', true, 'id', v_id);
end
$function$;

revoke all on function public.bp_report_submit(text, text, text, text, text, text) from public;
grant execute on function public.bp_report_submit(text, text, text, text, text, text) to anon, authenticated;

-- Reading them (dashboard / SQL editor):
--   select id, created_at, name, contact, message, char_length(log_text) as log_chars, char_length(blueprint_text) as bp_chars, status
--   from public.bp_reports order by created_at desc;
