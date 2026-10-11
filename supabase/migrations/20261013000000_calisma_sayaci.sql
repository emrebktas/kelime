-- =====================================================================
-- Kelime: çalışma sayacı oturumları (cihazlar arası senkron)
-- Supabase SQL Editor'de bir kez çalıştırılır.
-- =====================================================================

create table public.study_sessions (
  id uuid primary key,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  started_at bigint not null,           -- unix saniye
  ended_at bigint not null,
  planned_min int not null check (planned_min between 1 and 180),
  actual_sec int not null check (actual_sec between 0 and 86400),
  device text not null default '' check (char_length(device) <= 60),
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);
create index study_sessions_user_idx on public.study_sessions(user_id, updated_at);

create trigger study_sessions_touch before insert or update on public.study_sessions
  for each row execute function public.touch();

alter table public.study_sessions enable row level security;
create policy study_sessions_own on public.study_sessions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.study_sessions from anon;
revoke delete on public.study_sessions from authenticated;
