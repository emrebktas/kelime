-- =====================================================================
-- Kelime: IELTS yazıları (essay) — cihazlar arası senkron
-- Supabase SQL Editor'de bir kez çalıştırılır.
-- =====================================================================

create table public.essays (
  id uuid primary key,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null default '' check (char_length(title) <= 200),
  task text not null default 'task2' check (task in ('task2', 'task1', 'gt1', 'free')),
  prompt text not null default '' check (char_length(prompt) <= 5000),
  body text not null default '' check (char_length(body) <= 50000),
  words int not null default 0 check (words >= 0),
  created_at bigint not null,          -- unix saniye (cihaz saati)
  edited_at bigint not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);
create index essays_user_idx on public.essays(user_id, updated_at);

create trigger essays_touch before insert or update on public.essays
  for each row execute function public.touch();

alter table public.essays enable row level security;
create policy essays_own on public.essays for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.essays from anon;
revoke delete on public.essays from authenticated;
