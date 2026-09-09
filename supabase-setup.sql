-- Property tab · cloud-synced saved deals
-- Paste this whole file into Supabase → SQL Editor → New query → Run.

create table if not exists public.deals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deals_user_updated_idx
  on public.deals (user_id, updated_at desc);

-- Row Level Security is what actually protects the data: the key that ships
-- in the page is public by design, and these policies mean it can only ever
-- read or write rows belonging to the signed-in account.
alter table public.deals enable row level security;

drop policy if exists "own deals" on public.deals;
create policy "own deals" on public.deals
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
