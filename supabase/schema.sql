-- 데일리 플래너 전체 상태.
-- 앱에 로그인이 없어서 publishable 키(anon)로 이 한 줄을 읽고 쓴다.

create table if not exists public.planner_state (
  id text primary key,
  routines jsonb not null default '[]'::jsonb,
  routine_checks jsonb not null default '{}'::jsonb,
  todos jsonb not null default '{}'::jsonb,
  diary jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.planner_state enable row level security;

grant select, insert, update, delete on public.planner_state to anon, authenticated;

drop policy if exists "planner_state_public_all" on public.planner_state;
create policy "planner_state_public_all"
  on public.planner_state
  for all
  to anon, authenticated
  using (true)
  with check (true);
