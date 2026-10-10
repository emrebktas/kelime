-- =====================================================================
-- Kelime: güvenlik sıkılaştırmaları
-- Supabase SQL Editor'de bir kez çalıştırılır (ilk şemadan sonra).
-- =====================================================================

-- ---------------------------------------------------------------- 1) Çıkarılan üye kendini geri ekleyemesin
-- Üyeler `removed` alanını sadece desteden ayrılmak için değiştirebilir. Geri dönüş yalnızca
-- paylaşım koduyla (join_deck) olur. Fonksiyonlar tanımlayıcı yetkisiyle çalıştığı için
-- current_user orada 'authenticated' değildir.
create or replace function public.members_guard() returns trigger
language plpgsql as $$
begin
  if new.role = 'owner' and new.removed then
    raise exception 'Deste sahibi desteden ayrılamaz; desteyi silebilir.';
  end if;
  if current_user = 'authenticated' and old.removed and not new.removed then
    raise exception 'Desteye tekrar katılmak için paylaşım kodu gerekir.';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;

-- ---------------------------------------------------------------- 2) Silinen destelerin içeriği kapansın

create or replace function public.can_read(p_deck uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from deck_members m join decks d on d.id = m.deck_id
                 where m.deck_id = p_deck and m.user_id = auth.uid() and not m.removed and not d.deleted);
$$;

create or replace function public.can_edit(p_deck uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from deck_members m join decks d on d.id = m.deck_id
                 where m.deck_id = p_deck and m.user_id = auth.uid() and not m.removed and not d.deleted
                   and m.role in ('owner', 'editor'));
$$;

drop policy cards_read on public.cards;
create policy cards_read on public.cards for select to authenticated using (public.can_read(deck_id));
drop policy changes_read on public.changes;
create policy changes_read on public.changes for select to authenticated using (public.can_read(deck_id));

-- ---------------------------------------------------------------- 3) Tahmin edilemez paylaşım kodu + deneme sınırı
-- 10 karakter, karışmayan 32 harf/rakam (I, O, 0, 1 yok): ~50 bit rastgelelik.
create or replace function public.new_share_code() returns text
language plpgsql volatile as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  b bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  idx int[] := array[0, 1, 2, 3, 4, 5, 9, 10, 11, 12];  -- UUID'nin rastgele baytları (sürüm/varyant baytları hariç)
  code text := '';
  i int;
begin
  foreach i in array idx loop
    code := code || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return code;
end $$;

create table if not exists public.join_attempts (
  id bigserial primary key,
  user_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists join_attempts_user_idx on public.join_attempts(user_id, at);
alter table public.join_attempts enable row level security;
revoke all on public.join_attempts from anon, authenticated;

-- Bulunamayan kodda hata fırlatmak yerine null döner; böylece hatalı deneme kaydı geri alınmaz.
create or replace function public.join_deck(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  d uuid;
  fails int;
begin
  if auth.uid() is null then
    raise exception 'Giriş yapman gerekiyor.';
  end if;
  select count(*) into fails from join_attempts
  where user_id = auth.uid() and at > now() - interval '1 hour';
  if fails >= 10 then
    raise exception 'Çok fazla hatalı kod denendi. Bir saat sonra tekrar dene.';
  end if;
  select id into d from decks
  where share_code = upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')) and not deleted;
  if d is null then
    insert into join_attempts(user_id) values (auth.uid());
    delete from join_attempts where at < now() - interval '1 day';
    return null;
  end if;
  insert into deck_members(deck_id, user_id, role)
  values (d, auth.uid(), 'viewer')
  on conflict (deck_id, user_id) do update set removed = false where deck_members.removed;
  return d;
end $$;

-- Üye çıkarılınca paylaşım kodu da yenilenir: çıkarılan kişi eski kodla geri dönemez.
drop function if exists public.remove_member(uuid, uuid) cascade;
create function public.remove_member(p_deck uuid, p_user uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  code text := public.new_share_code();
begin
  if not exists (select 1 from decks where id = p_deck and owner_id = auth.uid()) then
    raise exception 'Sadece deste sahibi üye çıkarabilir.';
  end if;
  update deck_members set removed = true
  where deck_id = p_deck and user_id = p_user and role <> 'owner';
  update decks set share_code = code where id = p_deck;
  return code;
end $$;
revoke execute on function public.remove_member from anon, public;
grant execute on function public.remove_member to authenticated;

-- Eski (kısa) kodları yenile
update public.decks set share_code = public.new_share_code();

-- ---------------------------------------------------------------- 4) Kullanıcı adları sadece ortak destedekilere görünsün

create or replace function public.shares_deck_with(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_user = auth.uid() or exists (
    select 1 from deck_members a join deck_members b on a.deck_id = b.deck_id
    where a.user_id = auth.uid() and not a.removed and b.user_id = p_user);
$$;

drop policy profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (public.shares_deck_with(id));

-- ---------------------------------------------------------------- 5) Uzunluk sınırları

alter table public.profiles add constraint profiles_name_len check (char_length(display_name) <= 50);
alter table public.decks
  add constraint decks_name_len check (char_length(name) between 1 and 100),
  add constraint decks_lang_len check (char_length(language) <= 12),
  add constraint decks_device_len check (char_length(updated_device) <= 60);
alter table public.cards
  add constraint cards_word_len check (char_length(word) between 1 and 300),
  add constraint cards_translation_len check (char_length(translation) <= 2000),
  add constraint cards_sentence_len check (char_length(sentence) <= 5000),
  add constraint cards_notes_len check (char_length(notes) <= 5000),
  add constraint cards_synonyms_len check (char_length(synonyms::text) <= 5000),
  add constraint cards_extra_len check (char_length(extra::text) <= 10000),
  add constraint cards_device_len check (char_length(updated_device) <= 60);
alter table public.revlog add constraint revlog_device_len check (char_length(device) <= 60);

-- ---------------------------------------------------------------- 6) Kimlikler değiştirilemesin

create or replace function public.keep_id() returns trigger
language plpgsql as $$
begin
  if new.id <> old.id then
    raise exception 'Kayıt kimliği değiştirilemez.';
  end if;
  return new;
end $$;
create trigger decks_keep_id before update on public.decks for each row execute function public.keep_id();
create trigger cards_keep_id before update on public.cards for each row execute function public.keep_id();
