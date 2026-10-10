-- =====================================================================
-- Kelime: yapay zekâ ile kart doldurma için kullanım kaydı
-- Supabase SQL Editor'de bir kez çalıştırılır.
-- =====================================================================

-- kelime-ai fonksiyonu her istekte buraya yazar; kişi başı günlük sınır buradan hesaplanır.
-- Sadece sunucu (service role) erişir, kullanıcılara tamamen kapalıdır.
create table public.ai_usage (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  words int not null check (words > 0),
  at timestamptz not null default now()
);
create index ai_usage_user_idx on public.ai_usage(user_id, at);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;
