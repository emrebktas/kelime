-- =====================================================================
-- Kelime: ana sayfada etkinlik akışı (ortak destedekiler: kelime ekledi / çalıştı)
-- Supabase SQL Editor'de bir kez çalıştırılır. Çalışma panosu SQL'inden (user_status) sonra çalıştırılmalı.
-- =====================================================================

-- Sadece hâlâ ortak bir destede olduğun kişiler. Kelime eklemeleri sadece ortak destelerden gelir;
-- çalışma oturumları, panoda görünürlüğünü "Kimse" yapanlar için gösterilmez.
create or replace function public.activity_feed(p_days int default 7)
returns table (kind text, user_id uuid, display_name text, deck_id uuid, deck_name text,
               at timestamptz, word text, seconds int)
language sql stable security definer set search_path = public as $$
  with since as (
    select now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 30)) as t
  ),
  peers as (
    select distinct y.user_id, y.deck_id
    from deck_members x
    join deck_members y on y.deck_id = x.deck_id and y.user_id <> x.user_id and not y.removed
    join decks d on d.id = x.deck_id and not d.deleted
    where x.user_id = auth.uid() and not x.removed
  ),
  cards as (
    select 'card'::text, c.user_id, p.display_name, c.deck_id, d.name, c.at, left(c.summary, 120), null::int
    from changes c
    join peers pr on pr.user_id = c.user_id and pr.deck_id = c.deck_id
    join profiles p on p.id = c.user_id
    join decks d on d.id = c.deck_id
    where c.entity = 'card' and c.action = 'create' and c.at > (select t from since)
    order by c.at desc
    limit 300
  ),
  study as (
    select 'study'::text, s.user_id, p.display_name, null::uuid, null::text,
           to_timestamp(s.ended_at), null::text, s.actual_sec
    from study_sessions s
    join profiles p on p.id = s.user_id
    left join user_status us on us.user_id = s.user_id
    where s.user_id in (select pr.user_id from peers pr)
      and not s.deleted
      and coalesce(us.visibility, 'shared') <> 'nobody'
      and s.ended_at > extract(epoch from (select t from since))
    order by s.ended_at desc
    limit 100
  )
  select * from cards
  union all
  select * from study
  order by 6 desc;
$$;

revoke execute on function public.activity_feed from anon, public;
grant execute on function public.activity_feed to authenticated;
