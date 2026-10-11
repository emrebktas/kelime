-- =====================================================================
-- Kelime: çalışma panosu (bugün kim ne kadar çalıştı, kaç kelime ekledi, çevrimiçi mi)
-- Supabase SQL Editor'de bir kez çalıştırılır.
-- =====================================================================

-- Uygulama açıkken dakikada bir güncellenir (çevrimiçi ışığı ve "şu an çalışıyor" için)
create table public.user_status (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_seen timestamptz not null default now(),
  studying_since bigint,   -- sayaç çalışıyorsa: geçen süreyi veren başlangıç (unix sn); değilse null
  visibility text not null default 'shared' check (visibility in ('everyone', 'shared', 'nobody'))
);
alter table public.user_status enable row level security;
revoke all on public.user_status from anon, authenticated;
-- Tabloya doğrudan erişim yok; sadece aşağıdaki fonksiyonlar (tanımlayıcı yetkisiyle) kullanır.

create function public.heartbeat(p_studying_since bigint) returns void
language sql volatile security definer set search_path = public as $$
  insert into user_status(user_id, last_seen, studying_since)
  values (auth.uid(), now(), p_studying_since)
  on conflict (user_id) do update set last_seen = now(), studying_since = excluded.studying_since;
$$;

create function public.set_board_visibility(p_visibility text) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if p_visibility not in ('everyone', 'shared', 'nobody') then
    raise exception 'Geçersiz görünürlük.';
  end if;
  insert into user_status(user_id, visibility) values (auth.uid(), p_visibility)
  on conflict (user_id) do update set visibility = excluded.visibility;
end $$;

-- Pano: kendin + seni görmeye izin verenler ("herkes" ya da ortak destedekiler).
-- Sadece ad, çevrimiçi durumu, bugün eklenen kelime sayısı ve çalışma süresi döner.
create or replace function public.study_board(p_since timestamptz)
returns table (user_id uuid, display_name text, is_me boolean, visibility text, last_seen timestamptz,
               studying_since bigint, words_today int, seconds_today int)
language sql stable security definer set search_path = public as $$
  with visible as (
    select p.id, p.display_name, coalesce(s.visibility, 'shared') as vis, s.last_seen, s.studying_since
    from profiles p
    left join user_status s on s.user_id = p.id
    where auth.uid() is not null
      and (p.id = auth.uid()
           or coalesce(s.visibility, 'shared') = 'everyone'
           or (coalesce(s.visibility, 'shared') = 'shared' and exists (
                 -- ikisi de desteye hâlâ üye ve deste silinmemiş (eski üyeler panoda görünmez)
                 select 1 from deck_members a
                 join deck_members b on b.deck_id = a.deck_id
                 join decks d on d.id = a.deck_id
                 where a.user_id = auth.uid() and not a.removed
                   and b.user_id = p.id and not b.removed and not d.deleted)))
  )
  select v.id, v.display_name, v.id = auth.uid(), v.vis, v.last_seen, v.studying_since,
         (select count(*) from changes c
           where c.user_id = v.id and c.entity = 'card' and c.action = 'create' and c.at >= p_since)::int,
         (select coalesce(sum(ss.actual_sec), 0) from study_sessions ss
           where ss.user_id = v.id and not ss.deleted and ss.started_at >= extract(epoch from p_since))::int
  from visible v
  order by 8 desc, 7 desc, 2
  limit 50;
$$;

revoke execute on function public.heartbeat, public.set_board_visibility, public.study_board from anon, public;
grant execute on function public.heartbeat, public.set_board_visibility, public.study_board to authenticated;
