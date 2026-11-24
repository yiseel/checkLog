-- 체크로그 스키마. 여러 번 실행해도 되는 형태(idempotent)로 작성했다.
--
-- 로그인: Supabase Auth는 이메일로만 계정을 만들 수 있어서, 앱은 "아이디@checklog.local"
-- 내부용 이메일로 가입시키고 실제 아이디는 user_metadata.username 과 profiles.username 에 둔다.
-- 메일은 보내지 않으므로 대시보드 Authentication > Sign In / Providers > Email 에서
-- Confirm email 을 꺼야 한다. 비밀번호는 auth.users 에 암호화되어 보관된다.

/* ---------------------------------------------------------
 * profiles: 로그인 아이디
 * --------------------------------------------------------- */
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists profiles_username_key on public.profiles (lower(username));

comment on table public.profiles is '로그인한 계정의 아이디. 비밀번호는 auth.users에 암호화되어 있다.';
comment on column public.profiles.username is '로그인 아이디(영문 소문자·숫자·밑줄 4~20자).';

alter table public.profiles enable row level security;

grant select, insert, update on public.profiles to authenticated;

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'username', ''),
      case when new.email like '%@checklog.local' then split_part(new.email, '@', 1) end,
      new.email,
      new.id::text
    )
  )
  on conflict (id) do update set username = excluded.username;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

/* ---------------------------------------------------------
 * planner_state: 계정별 체크로그 전체 상태 (계정당 한 줄, id = user_id 문자열)
 * --------------------------------------------------------- */
create table if not exists public.planner_state (
  id text primary key,
  routines jsonb not null default '[]'::jsonb,
  routine_checks jsonb not null default '{}'::jsonb,
  todos jsonb not null default '{}'::jsonb,
  diary jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.planner_state
  add column if not exists user_id uuid references auth.users (id) on delete cascade;

create unique index if not exists planner_state_user_id_key on public.planner_state (user_id);

comment on column public.planner_state.user_id is '이 데이터의 계정. auth.users.id';

alter table public.planner_state enable row level security;

-- 로그인 이전에는 anon 키로 공용 한 줄('default')을 읽고 썼다. 이제는 로그인한 본인 줄만.
drop policy if exists "planner_state_public_all" on public.planner_state;
drop policy if exists planner_state_select on public.planner_state;
drop policy if exists planner_state_insert on public.planner_state;
drop policy if exists planner_state_update on public.planner_state;
drop policy if exists planner_state_delete on public.planner_state;

revoke all on public.planner_state from anon;
grant select, insert, update, delete on public.planner_state to authenticated;

create policy planner_state_select on public.planner_state
  for select to authenticated using (user_id = (select auth.uid()));
create policy planner_state_insert on public.planner_state
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy planner_state_update on public.planner_state
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy planner_state_delete on public.planner_state
  for delete to authenticated using (user_id = (select auth.uid()));

-- 로그인 기능 이전에 저장된 공용 데이터('default', user_id 없음)는
-- 아직 데이터가 없는 계정이 처음 로그인할 때 그 계정 것으로 옮긴다(한 번만).
create or replace function public.claim_default_planner()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  if exists (select 1 from public.planner_state where user_id = auth.uid()) then
    return;
  end if;
  update public.planner_state
  set id = auth.uid()::text, user_id = auth.uid()
  where id = 'default' and user_id is null;
end;
$$;

revoke all on function public.claim_default_planner() from public;
grant execute on function public.claim_default_planner() to authenticated;
