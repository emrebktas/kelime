-- =====================================================================
-- Kelime: Fachsprachprüfung (FSP) Zahnmedizin
-- Supabase SQL Editor'de bir kez çalıştırılır.
--   fsp_items : kişinin kendi vakaları (kind = 'case') ve denemeleri (kind = 'attempt')
--   fsp_usage : fsp-ai fonksiyonunun günlük kullanım kaydı (sadece sunucu erişir)
-- =====================================================================

create table if not exists public.fsp_items (
  id uuid primary key,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('case', 'attempt')),
  data jsonb not null check (octet_length(data::text) <= 300000),
  created_at bigint not null,          -- unix saniye (cihaz saati)
  edited_at bigint not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists fsp_items_user_idx on public.fsp_items(user_id, updated_at);

drop trigger if exists fsp_items_touch on public.fsp_items;
create trigger fsp_items_touch before insert or update on public.fsp_items
  for each row execute function public.touch();

alter table public.fsp_items enable row level security;
drop policy if exists fsp_items_own on public.fsp_items;
create policy fsp_items_own on public.fsp_items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.fsp_items from anon;
revoke delete on public.fsp_items from authenticated;

create table if not exists public.fsp_usage (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  units int not null check (units > 0),
  at timestamptz not null default now()
);
create index if not exists fsp_usage_user_idx on public.fsp_usage(user_id, at);
alter table public.fsp_usage enable row level security;
revoke all on public.fsp_usage from anon, authenticated;
