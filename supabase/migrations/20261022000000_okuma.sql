-- =====================================================================
-- Kelime: IELTS Reading testleri (metin + sorular, kullanıcının cevapları ve sonucu)
-- Supabase SQL Editor'de bir kez çalıştırılır.
-- Testler kişiye özeldir (telifli kitap içerikleri herkese açık dosyalara konmaz).
-- =====================================================================

create table public.reading_tests (
  id uuid primary key,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null default '' check (char_length(title) <= 200),
  content jsonb not null check (octet_length(content::text) <= 600000),
  answers jsonb not null default '{}'::jsonb check (octet_length(answers::text) <= 50000),
  result jsonb check (result is null or octet_length(result::text) <= 20000),
  created_at bigint not null,          -- unix saniye (cihaz saati)
  edited_at bigint not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);
create index reading_tests_user_idx on public.reading_tests(user_id, updated_at);

create trigger reading_tests_touch before insert or update on public.reading_tests
  for each row execute function public.touch();

alter table public.reading_tests enable row level security;
create policy reading_tests_own on public.reading_tests for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.reading_tests from anon;
revoke delete on public.reading_tests from authenticated;
