-- =====================================================================
-- Kelime: FSP kurs kütüphanesi (kişiye özel; sadece sahibi ve paylaşım koduyla katılanlar görür)
-- Supabase SQL Editor'de bir kez çalıştırılır.
--   fsp_library          : içerik (bölümler/bloklar, jsonb) + paylaşım kodu
--   fsp_library_members  : kodla katılan kişiler
--   storage 'fsp-kurs'   : görseller (yol: <kütüphane id>/img/...)
-- İçerik telifli kurs materyali olabilir: herkese açık değildir, GitHub'a girmez.
-- =====================================================================

create table if not exists public.fsp_library (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null default '' check (char_length(title) <= 200),
  content jsonb not null check (octet_length(content::text) <= 3000000),
  share_code text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists fsp_library_touch on public.fsp_library;
create trigger fsp_library_touch before update on public.fsp_library
  for each row execute function public.touch();

create table if not exists public.fsp_library_members (
  library_id uuid not null references public.fsp_library(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (library_id, user_id)
);

-- Okuma izni: sahibi ya da üyesi (RLS içinde özyineleme olmasın diye security definer)
create or replace function public.fsp_library_can_read(p_lib uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from fsp_library where id = p_lib and owner_id = auth.uid())
      or exists (select 1 from fsp_library_members where library_id = p_lib and user_id = auth.uid());
$$;
revoke execute on function public.fsp_library_can_read from anon, public;
grant execute on function public.fsp_library_can_read to authenticated;

alter table public.fsp_library enable row level security;
drop policy if exists fsp_library_read on public.fsp_library;
-- owner_id kontrolü doğrudan: ekleme sonrası RETURNING'de yeni satır fonksiyon içinden henüz görünmez
create policy fsp_library_read on public.fsp_library for select to authenticated
  using (owner_id = auth.uid() or public.fsp_library_can_read(id));
drop policy if exists fsp_library_insert on public.fsp_library;
create policy fsp_library_insert on public.fsp_library for insert to authenticated
  with check (owner_id = auth.uid());
drop policy if exists fsp_library_update on public.fsp_library;
create policy fsp_library_update on public.fsp_library for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists fsp_library_delete on public.fsp_library;
create policy fsp_library_delete on public.fsp_library for delete to authenticated
  using (owner_id = auth.uid());
revoke all on public.fsp_library from anon;

alter table public.fsp_library_members enable row level security;
drop policy if exists fsp_library_members_read on public.fsp_library_members;
create policy fsp_library_members_read on public.fsp_library_members for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from fsp_library l where l.id = library_id and l.owner_id = auth.uid()));
-- Ayrılma (kendi satırı) ya da sahibin üyeyi çıkarması
drop policy if exists fsp_library_members_delete on public.fsp_library_members;
create policy fsp_library_members_delete on public.fsp_library_members for delete to authenticated
  using (user_id = auth.uid() or exists (select 1 from fsp_library l where l.id = library_id and l.owner_id = auth.uid()));
revoke all on public.fsp_library_members from anon;
revoke insert, update on public.fsp_library_members from authenticated;

-- Kodla katılma (deste katılımıyla aynı hatalı deneme sınırı)
create or replace function public.join_fsp_library(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  l uuid;
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
  select id into l from fsp_library
  where share_code = upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'));
  if l is null then
    insert into join_attempts(user_id) values (auth.uid());
    return null;
  end if;
  insert into fsp_library_members(library_id, user_id) values (l, auth.uid())
  on conflict do nothing;
  return l;
end $$;
revoke execute on function public.join_fsp_library from anon, public;
grant execute on function public.join_fsp_library to authenticated;

-- Paylaşım kodunu oluşturur ya da yeniler (eski kod geçersiz olur; üyeler kalır)
create or replace function public.fsp_library_new_code(p_lib uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  c text := public.new_share_code();
begin
  if not exists (select 1 from fsp_library where id = p_lib and owner_id = auth.uid()) then
    raise exception 'Sadece kütüphanenin sahibi kod oluşturabilir.';
  end if;
  update fsp_library set share_code = c where id = p_lib;
  return c;
end $$;
revoke execute on function public.fsp_library_new_code from anon, public;
grant execute on function public.fsp_library_new_code to authenticated;

-- ---------------------------------------------------------------- görseller (özel depo)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fsp-kurs', 'fsp-kurs', false, 5242880, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;

drop policy if exists fsp_kurs_read on storage.objects;
create policy fsp_kurs_read on storage.objects for select to authenticated
  using (bucket_id = 'fsp-kurs' and public.fsp_library_can_read(((storage.foldername(name))[1])::uuid));
drop policy if exists fsp_kurs_write on storage.objects;
create policy fsp_kurs_write on storage.objects for insert to authenticated
  with check (bucket_id = 'fsp-kurs' and exists (
    select 1 from public.fsp_library l where l.id = ((storage.foldername(name))[1])::uuid and l.owner_id = auth.uid()));
drop policy if exists fsp_kurs_update on storage.objects;
create policy fsp_kurs_update on storage.objects for update to authenticated
  using (bucket_id = 'fsp-kurs' and exists (
    select 1 from public.fsp_library l where l.id = ((storage.foldername(name))[1])::uuid and l.owner_id = auth.uid()));
drop policy if exists fsp_kurs_delete on storage.objects;
create policy fsp_kurs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'fsp-kurs' and exists (
    select 1 from public.fsp_library l where l.id = ((storage.foldername(name))[1])::uuid and l.owner_id = auth.uid()));
