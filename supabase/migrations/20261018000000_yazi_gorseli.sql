-- =====================================================================
-- Kelime: yazılara görsel (IELTS Academic Task 1 grafiği / tablosu / diyagramı)
-- Supabase SQL Editor'de bir kez çalıştırılır.
-- =====================================================================

-- Görsel, yazı satırından ayrı tutulur: yazı her kaydedildiğinde görsel yeniden gönderilmez.
-- Cihazda küçültülüp sıkıştırılmış "data:image/...;base64,..." metni olarak saklanır.
create table public.essay_images (
  essay_id uuid primary key references public.essays(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  data text not null default ''
    check (char_length(data) <= 2800000
           and (data = '' or data ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$')),
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);
create index essay_images_user_idx on public.essay_images(user_id, updated_at);

create trigger essay_images_touch before insert or update on public.essay_images
  for each row execute function public.touch();

alter table public.essay_images enable row level security;
create policy essay_images_own on public.essay_images for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and exists (select 1 from public.essays e where e.id = essay_id and e.user_id = auth.uid()));
revoke all on public.essay_images from anon;
revoke delete on public.essay_images from authenticated;
