-- Cloud data for the site: card claims (Cards tab) and saved deals (Tools → Property).
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run again; it only creates what's missing.
--
-- Row Level Security is what actually protects the data: the key that ships
-- in the page is public by design, and these policies mean it can only ever
-- read or write rows belonging to the signed-in account.

-- ─── Card claims ───
-- One row per benefit per period ("2026-03", "2026-Q4", "2026-H1", "2026",
-- "once"). claimed = false means un-marked by hand, which stops a YNAB
-- statement credit from marking that period again.
create table if not exists public.card_claims (
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  card_id     text not null,
  benefit_id  text not null,
  period      text not null,
  claimed     boolean not null default true,
  source      text not null default 'manual' check (source in ('manual', 'ynab', 'import')),
  amount      numeric(10, 2),
  posted_on   date,
  ynab_txn_id text,
  updated_at  timestamptz not null default now(),
  primary key (user_id, card_id, benefit_id, period)
);

alter table public.card_claims enable row level security;

drop policy if exists "own claims" on public.card_claims;
create policy "own claims" on public.card_claims
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ─── Property deals ───
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

alter table public.deals enable row level security;

drop policy if exists "own deals" on public.deals;
create policy "own deals" on public.deals
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
