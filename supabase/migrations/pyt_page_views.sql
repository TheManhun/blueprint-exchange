-- tfbpx.com: a page view counter (Epod, 2026-11-04: 'on our notes page add a counter'). Project aijqcrrcreectihaeqoc.
--   * one view per visitor per page per day (bp_caller_hash, the site's existing hashed caller -- no IP is stored),
--     so a refresh never adds one
--   * only the listed pages count (a stranger can't fill the table with names of their own)
--   * RLS on, NO policies: the site reads the number only through the function, which returns the total

create table if not exists public.pyt_page_views (
    page       text primary key,
    views      bigint not null default 0,
    updated_at timestamptz not null default now()
);

create table if not exists public.pyt_page_visits (
    page        text not null,
    caller_hash text not null,
    day         date not null default current_date,
    primary key (page, caller_hash, day)
);

alter table public.pyt_page_views enable row level security;   -- and no policies
alter table public.pyt_page_visits enable row level security;  -- and no policies
revoke all on public.pyt_page_views from anon, authenticated;
revoke all on public.pyt_page_visits from anon, authenticated;

create or replace function public.pyt_page_view(p_page text)
returns bigint
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
    v_n bigint;
    v_new int;
begin
    if p_page is null or p_page not in ('modder-notes', 'early-access') then
        return null;
    end if;
    insert into public.pyt_page_visits (page, caller_hash) values (p_page, public.bp_caller_hash())
        on conflict do nothing;
    get diagnostics v_new = row_count;
    insert into public.pyt_page_views (page, views) values (p_page, v_new)
        on conflict (page) do update set views = public.pyt_page_views.views + v_new,
            updated_at = case when v_new > 0 then now() else public.pyt_page_views.updated_at end
        returning views into v_n;
    -- old visit rows are only there to stop double counts within a day
    delete from public.pyt_page_visits where day < current_date - 2;
    return v_n;
end
$function$;

revoke all on function public.pyt_page_view(text) from public;
grant execute on function public.pyt_page_view(text) to anon, authenticated;
