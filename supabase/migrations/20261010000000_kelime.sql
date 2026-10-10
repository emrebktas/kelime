-- =====================================================================
-- Kelime: hesaplar, senkron, ortak desteler ve değişiklik geçmişi
-- Supabase projesinde SQL Editor'e yapıştırıp bir kez çalıştırılır.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tablolar

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

create table public.decks (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name text not null,
  language text not null default 'en',
  share_code text unique,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  updated_device text not null default ''
);
create index decks_updated_idx on public.decks(updated_at);

-- Destenin üyeleri; yeni kart sayısı ve kart yönü kişiye özeldir.
create table public.deck_members (
  deck_id uuid not null references public.decks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'viewer' check (role in ('owner', 'editor', 'viewer')),
  new_per_day int not null default 20 check (new_per_day between 0 and 9999),
  direction text not null default 'front' check (direction in ('front', 'back', 'mixed')),
  removed boolean not null default false,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (deck_id, user_id)
);
create index deck_members_user_idx on public.deck_members(user_id);
create index deck_members_updated_idx on public.deck_members(updated_at);

create table public.cards (
  id uuid primary key,
  deck_id uuid not null references public.decks(id) on delete cascade,
  word text not null,
  translation text not null default '',
  sentence text not null default '',
  synonyms jsonb not null default '[]',
  notes text not null default '',
  extra jsonb not null default '{}',
  position double precision not null default 0,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  updated_device text not null default ''
);
create index cards_deck_idx on public.cards(deck_id, updated_at);
create index cards_updated_idx on public.cards(updated_at);

-- Kişiye özel çalışma ilerlemesi (ortak destelerde herkesin ilerlemesi ayrıdır)
create table public.card_states (
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  card_id uuid not null,
  deck_id uuid not null,
  state smallint not null default 0,
  due bigint not null default 0,
  ivl int not null default 0,
  ease real not null default 2.5,
  step smallint not null default 0,
  reps int not null default 0,
  lapses int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, card_id)
);
create index card_states_updated_idx on public.card_states(user_id, updated_at);

create table public.revlog (
  id uuid primary key,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  card_id uuid not null,
  deck_id uuid not null,
  time bigint not null,
  rating smallint not null check (rating between 1 and 4),
  state_before smallint not null,
  ivl int not null default 0,
  undone boolean not null default false,
  device text not null default '',
  updated_at timestamptz not null default now()
);
create index revlog_updated_idx on public.revlog(user_id, updated_at);

-- Değişiklik geçmişi: kim, hangi cihazdan, ne zaman, neyi değiştirdi
create table public.changes (
  id bigserial primary key,
  deck_id uuid not null references public.decks(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  device text not null default '',
  entity text not null,   -- deck | card | member
  entity_id uuid,
  action text not null,   -- create | update | delete | restore | move_in | move_out | join | leave | role
  summary text not null default '',
  diff jsonb,
  at timestamptz not null default now()
);
create index changes_deck_idx on public.changes(deck_id, at desc);

-- ---------------------------------------------------------------- yardımcılar

create function public.is_member(p_deck uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from deck_members
                 where deck_id = p_deck and user_id = auth.uid() and not removed);
$$;

create function public.can_edit(p_deck uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from deck_members
                 where deck_id = p_deck and user_id = auth.uid() and not removed
                   and role in ('owner', 'editor'));
$$;

create function public.new_share_code() returns text
language sql volatile as $$
  select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
$$;

-- ---------------------------------------------------------------- tetikleyiciler

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles(id, display_name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
                           split_part(new.email, '@', 1)));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Senkron imleci için sunucu saati; düzenleyen kişi
create function public.touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

create function public.touch_edit() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  return new;
end $$;

create function public.decks_before_insert() returns trigger
language plpgsql as $$
begin
  new.owner_id := coalesce(auth.uid(), new.owner_id);
  new.share_code := public.new_share_code();
  return new;
end $$;

create function public.decks_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into deck_members(deck_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (deck_id, user_id) do nothing;
  insert into changes(deck_id, user_id, device, entity, entity_id, action, summary)
  values (new.id, new.owner_id, new.updated_device, 'deck', new.id, 'create', new.name);
  return null;
end $$;

create function public.decks_log_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := '{}';
begin
  if new.deleted and not old.deleted then
    insert into changes(deck_id, user_id, device, entity, entity_id, action, summary)
    values (new.id, auth.uid(), new.updated_device, 'deck', new.id, 'delete', new.name);
    return null;
  end if;
  if new.name is distinct from old.name then
    d := d || jsonb_build_object('name', jsonb_build_array(old.name, new.name));
  end if;
  if new.language is distinct from old.language then
    d := d || jsonb_build_object('language', jsonb_build_array(old.language, new.language));
  end if;
  if d <> '{}' then
    insert into changes(deck_id, user_id, device, entity, entity_id, action, summary, diff)
    values (new.id, auth.uid(), new.updated_device, 'deck', new.id, 'update', new.name, d);
  end if;
  return null;
end $$;

create function public.cards_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := '{}';
  f text;
  act text;
begin
  if tg_op = 'INSERT' then
    act := case when new.deleted then null else 'create' end;
  elsif new.deck_id <> old.deck_id then
    insert into changes(deck_id, user_id, device, entity, entity_id, action, summary)
    values (old.deck_id, auth.uid(), new.updated_device, 'card', new.id, 'move_out', new.word);
    act := 'move_in';
  elsif new.deleted and not old.deleted then
    act := 'delete';
  elsif old.deleted and not new.deleted then
    act := 'restore';
  else
    foreach f in array array['word', 'translation', 'sentence', 'synonyms', 'notes', 'extra'] loop
      if to_jsonb(new) -> f is distinct from to_jsonb(old) -> f then
        d := d || jsonb_build_object(f, jsonb_build_array(to_jsonb(old) -> f, to_jsonb(new) -> f));
      end if;
    end loop;
    act := case when d = '{}' then null else 'update' end;
  end if;
  if act is not null then
    insert into changes(deck_id, user_id, device, entity, entity_id, action, summary, diff)
    values (new.deck_id, auth.uid(), new.updated_device, 'card', new.id, act, new.word, nullif(d, '{}'));
  end if;
  return null;
end $$;

create function public.members_guard() returns trigger
language plpgsql as $$
begin
  if new.role = 'owner' and new.removed then
    raise exception 'Deste sahibi desteden ayrılamaz; desteyi silebilir.';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;

create function public.members_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  member_name text;
  act text;
  d jsonb;
begin
  select display_name into member_name from profiles where id = new.user_id;
  if tg_op = 'INSERT' then
    act := case when new.role = 'owner' then null else 'join' end;
  elsif new.removed and not old.removed then
    act := 'leave';
  elsif old.removed and not new.removed then
    act := 'join';
  elsif new.role <> old.role then
    act := 'role';
    d := jsonb_build_object('role', jsonb_build_array(old.role, new.role));
  end if;
  if act is not null then
    insert into changes(deck_id, user_id, entity, entity_id, action, summary, diff)
    values (new.deck_id, coalesce(auth.uid(), new.user_id), 'member', new.user_id, act,
            coalesce(member_name, ''), d);
  end if;
  return null;
end $$;

create trigger decks_touch before update on public.decks
  for each row execute function public.touch_edit();
create trigger decks_insert before insert on public.decks
  for each row execute function public.decks_before_insert();
create trigger decks_insert_touch before insert on public.decks
  for each row execute function public.touch_edit();
create trigger decks_created after insert on public.decks
  for each row execute function public.decks_after_insert();
create trigger decks_updated after update on public.decks
  for each row execute function public.decks_log_update();

create trigger cards_touch before insert or update on public.cards
  for each row execute function public.touch_edit();
create trigger cards_logged after insert or update on public.cards
  for each row execute function public.cards_log();

create trigger members_touch before insert or update on public.deck_members
  for each row execute function public.members_guard();
create trigger members_logged after insert or update on public.deck_members
  for each row execute function public.members_log();

create trigger card_states_touch before insert or update on public.card_states
  for each row execute function public.touch();
create trigger revlog_touch before insert or update on public.revlog
  for each row execute function public.touch();

-- ---------------------------------------------------------------- paylaşım fonksiyonları

create function public.join_deck(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  d uuid;
begin
  if auth.uid() is null then
    raise exception 'Giriş yapman gerekiyor.';
  end if;
  select id into d from decks where share_code = upper(trim(code)) and not deleted;
  if d is null then
    raise exception 'Bu kodla bir deste bulunamadı.';
  end if;
  insert into deck_members(deck_id, user_id, role)
  values (d, auth.uid(), 'viewer')
  on conflict (deck_id, user_id) do update set removed = false where deck_members.removed;
  return d;
end $$;

create function public.set_member_role(p_deck uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from decks where id = p_deck and owner_id = auth.uid()) then
    raise exception 'Sadece deste sahibi yetki değiştirebilir.';
  end if;
  if p_role not in ('editor', 'viewer') then
    raise exception 'Geçersiz yetki.';
  end if;
  update deck_members set role = p_role
  where deck_id = p_deck and user_id = p_user and role <> 'owner';
end $$;

create function public.remove_member(p_deck uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from decks where id = p_deck and owner_id = auth.uid()) then
    raise exception 'Sadece deste sahibi üye çıkarabilir.';
  end if;
  update deck_members set removed = true
  where deck_id = p_deck and user_id = p_user and role <> 'owner';
end $$;

create function public.regenerate_share_code(p_deck uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  code text := public.new_share_code();
begin
  update decks set share_code = code where id = p_deck and owner_id = auth.uid();
  if not found then
    raise exception 'Sadece deste sahibi paylaşım kodunu yenileyebilir.';
  end if;
  return code;
end $$;

-- ---------------------------------------------------------------- erişim kuralları (RLS)

alter table public.profiles enable row level security;
alter table public.decks enable row level security;
alter table public.deck_members enable row level security;
alter table public.cards enable row level security;
alter table public.card_states enable row level security;
alter table public.revlog enable row level security;
alter table public.changes enable row level security;

create policy profiles_read on public.profiles for select to authenticated using (true);
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy decks_read on public.decks for select to authenticated
  using (owner_id = auth.uid() or public.is_member(id));
create policy decks_insert on public.decks for insert to authenticated
  with check (owner_id = auth.uid());
create policy decks_update on public.decks for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy members_read on public.deck_members for select to authenticated
  using (user_id = auth.uid() or public.is_member(deck_id));
create policy members_update on public.deck_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy cards_read on public.cards for select to authenticated
  using (public.is_member(deck_id));
create policy cards_insert on public.cards for insert to authenticated
  with check (public.can_edit(deck_id));
create policy cards_update on public.cards for update to authenticated
  using (public.can_edit(deck_id)) with check (public.can_edit(deck_id));

create policy states_own on public.card_states for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy revlog_own on public.revlog for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy changes_read on public.changes for select to authenticated
  using (public.is_member(deck_id));

-- Sütun düzeyinde yetkiler: sahiplik, paylaşım kodu ve rol yalnızca fonksiyonlarla değişir.
revoke all on public.profiles, public.decks, public.deck_members, public.cards,
              public.card_states, public.revlog, public.changes from anon;
revoke update, delete on public.profiles, public.decks, public.deck_members, public.cards,
                         public.changes from authenticated;
revoke delete on public.card_states, public.revlog from authenticated;
revoke insert on public.deck_members, public.changes, public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;
grant update (id, name, language, deleted, updated_device) on public.decks to authenticated;
grant update (new_per_day, direction, removed) on public.deck_members to authenticated;
grant update (id, deck_id, word, translation, sentence, synonyms, notes, extra, position, deleted, updated_device)
  on public.cards to authenticated;
revoke execute on function public.join_deck, public.set_member_role, public.remove_member,
                           public.regenerate_share_code from anon, public;
grant execute on function public.join_deck, public.set_member_role, public.remove_member,
                          public.regenerate_share_code to authenticated;
