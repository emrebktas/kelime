-- =====================================================================
-- Kelime: mesajlar (ortak destede olduğun kişilerle birebir sohbet)
-- Supabase SQL Editor'de bir kez çalıştırılır.
-- =====================================================================

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  sender uuid not null references public.profiles(id) on delete cascade,
  recipient uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (sender <> recipient)
);
create index messages_pair_idx on public.messages (sender, recipient, created_at desc);
create index messages_unread_idx on public.messages (recipient) where read_at is null;
alter table public.messages enable row level security;
revoke all on public.messages from anon, authenticated;
-- Tabloya doğrudan erişim yok; sadece aşağıdaki fonksiyonlar (tanımlayıcı yetkisiyle) kullanır.

-- İkisi de aynı desteye hâlâ üye ve deste silinmemiş mi? (sadece bu durumda mesaj gönderilebilir)
create function public.chat_peer_ok(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and b is not null and a <> b and exists (
    select 1 from deck_members x
    join deck_members y on y.deck_id = x.deck_id
    join decks d on d.id = x.deck_id
    where x.user_id = a and not x.removed
      and y.user_id = b and not y.removed and not d.deleted);
$$;

-- Kişi listesi: ortak destedekiler + daha önce yazıştıkların (artık ortak deste yoksa sadece okunur)
create function public.chat_contacts()
returns table (user_id uuid, display_name text, can_send boolean, last_body text,
               last_at timestamptz, last_from_me boolean, unread int)
language sql stable security definer set search_path = public as $$
  with peers as (
    select y.user_id as id
    from deck_members x
    join deck_members y on y.deck_id = x.deck_id and not y.removed and y.user_id <> x.user_id
    join decks d on d.id = x.deck_id and not d.deleted
    where x.user_id = auth.uid() and not x.removed
    union
    select case when m.sender = auth.uid() then m.recipient else m.sender end
    from messages m
    where m.sender = auth.uid() or m.recipient = auth.uid()
  )
  select p.id, p.display_name, chat_peer_ok(auth.uid(), p.id),
         left(l.body, 120), l.created_at, l.sender = auth.uid(),
         (select count(*) from messages u
           where u.sender = p.id and u.recipient = auth.uid() and u.read_at is null)::int
  from peers pr
  join profiles p on p.id = pr.id
  left join lateral (
    select m.body, m.created_at, m.sender from messages m
    where (m.sender = p.id and m.recipient = auth.uid()) or (m.sender = auth.uid() and m.recipient = p.id)
    order by m.created_at desc limit 1) l on true
  where auth.uid() is not null
  order by l.created_at desc nulls last, p.display_name
  limit 200;
$$;

-- Bir sohbetin mesajları (yeniden eskiye); p_before ile daha eskileri sayfalanır
create function public.chat_messages(p_other uuid, p_before timestamptz default null, p_limit int default 50)
returns table (id uuid, sender uuid, body text, created_at timestamptz, read_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.sender, m.body, m.created_at, m.read_at
  from messages m
  where auth.uid() is not null
    and ((m.sender = auth.uid() and m.recipient = p_other) or (m.sender = p_other and m.recipient = auth.uid()))
    and (p_before is null or m.created_at < p_before)
  order by m.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create function public.send_message(p_to uuid, p_body text)
returns table (id uuid, sender uuid, body text, created_at timestamptz, read_at timestamptz)
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_body text := btrim(coalesce(p_body, ''));
begin
  if auth.uid() is null then raise exception 'Giriş yapmalısın.'; end if;
  if v_body = '' then raise exception 'Boş mesaj gönderilemez.'; end if;
  if char_length(v_body) > 2000 then raise exception 'Mesaj en fazla 2000 karakter olabilir.'; end if;
  if not chat_peer_ok(auth.uid(), p_to) then
    raise exception 'Bu kişiyle ortak bir desten yok; mesaj gönderemezsin.' using errcode = '42501';
  end if;
  if (select count(*) from messages m
      where m.sender = auth.uid() and m.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Çok hızlı mesaj gönderiyorsun, biraz bekle.';
  end if;
  return query
    insert into messages (sender, recipient, body) values (auth.uid(), p_to, v_body)
    returning messages.id, messages.sender, messages.body, messages.created_at, messages.read_at;
end $$;

create function public.mark_chat_read(p_other uuid) returns void
language sql volatile security definer set search_path = public as $$
  update messages set read_at = now()
  where recipient = auth.uid() and sender = p_other and read_at is null;
$$;

-- Okunmamış mesajlar, gönderene göre (rozet ve "yeni mesaj" bildirimi için)
create function public.chat_unread()
returns table (sender uuid, display_name text, unread int, last_at timestamptz, last_body text)
language sql stable security definer set search_path = public as $$
  select m.sender, p.display_name, count(*)::int, max(m.created_at),
         (array_agg(left(m.body, 120) order by m.created_at desc))[1]
  from messages m
  join profiles p on p.id = m.sender
  where m.recipient = auth.uid() and m.read_at is null
  group by m.sender, p.display_name;
$$;

revoke execute on function public.chat_peer_ok from anon, authenticated, public;
revoke execute on function public.chat_contacts, public.chat_messages, public.send_message,
  public.mark_chat_read, public.chat_unread from anon, public;
grant execute on function public.chat_contacts, public.chat_messages, public.send_message,
  public.mark_chat_read, public.chat_unread to authenticated;
