-- =====================================================================
-- Kelime: bir kişinin geçmiş performansı (panoda kişiye tıklayınca açılan istatistikler)
-- Supabase SQL Editor'de bir kez çalıştırılır. Çalışma panosu SQL'inden (user_status) sonra çalıştırılmalı.
-- =====================================================================

-- Gün gün çalışma süresi ve eklenen kelime sayısı (son p_days gün, izleyenin saat dilimine göre).
-- Görme kuralı panoyla aynı: kendin; "Herkes" diyenler; "Ortak destedekiler" diyenler için hâlâ ortak bir deste.
-- "Kimse" diyenlerin istatistikleri kimseye dönmez.
create or replace function public.user_stats(p_user uuid, p_days int default 28, p_tz text default 'UTC')
returns table (day date, seconds int, words int)
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text := coalesce((select name from pg_timezone_names where name = p_tz limit 1), 'UTC');
  v_days int := least(greatest(coalesce(p_days, 28), 1), 90);
  v_vis text;
  v_today date;
begin
  if auth.uid() is null or p_user is null then return; end if;
  if p_user <> auth.uid() then
    select s.visibility into v_vis from user_status s where s.user_id = p_user;
    v_vis := coalesce(v_vis, 'shared');
    if v_vis = 'nobody' then return; end if;
    if v_vis = 'shared' and not exists (
      select 1 from deck_members a
      join deck_members b on b.deck_id = a.deck_id
      join decks d on d.id = a.deck_id
      where a.user_id = auth.uid() and not a.removed
        and b.user_id = p_user and not b.removed and not d.deleted) then
      return;
    end if;
  end if;
  v_today := (now() at time zone v_tz)::date;
  return query
  with days as (
    select (v_today - g)::date as d from generate_series(0, v_days - 1) g
  ),
  s as (
    select (to_timestamp(ss.started_at) at time zone v_tz)::date as d, sum(ss.actual_sec)::int as sec
    from study_sessions ss
    where ss.user_id = p_user and not ss.deleted
      and ss.started_at >= extract(epoch from now() - make_interval(days => v_days + 1))
    group by 1
  ),
  w as (
    select (c.at at time zone v_tz)::date as d, count(*)::int as n
    from changes c
    where c.user_id = p_user and c.entity = 'card' and c.action = 'create'
      and c.at >= now() - make_interval(days => v_days + 1)
    group by 1
  )
  select days.d, coalesce(s.sec, 0), coalesce(w.n, 0)
  from days
  left join s on s.d = days.d
  left join w on w.d = days.d
  order by days.d;
end $$;

revoke execute on function public.user_stats from anon, public;
grant execute on function public.user_stats to authenticated;
