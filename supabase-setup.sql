-- Cloud data for the site: card claims (Cards tab) and saved deals (Tools → Property).
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run again; it only creates what's missing.
--
-- Only worker.js talks to these tables, using the SupabaseKey Worker secret,
-- so the site password is the one login. Row-level security is on with no
-- policies and the public roles have no grants: the public (publishable /
-- anon) key can't read or write anything here. The secret key bypasses RLS.

-- ─── Card claims ───
-- One row per benefit per period ("2026-03", "2026-Q4", "2026-H1", "2026",
-- "once"). claimed = false means un-marked by hand, which stops a YNAB
-- statement credit from marking that period again.
create table if not exists public.card_claims (
  card_id     text not null,
  benefit_id  text not null,
  period      text not null,
  claimed     boolean not null default true,
  source      text not null default 'manual' check (source in ('manual', 'ynab', 'import')),
  amount      numeric(10, 2),
  posted_on   date,
  ynab_txn_id text,
  updated_at  timestamptz not null default now(),
  primary key (card_id, benefit_id, period)
);
alter table public.card_claims enable row level security;
revoke all on public.card_claims from anon, authenticated;

-- ─── Property deals ───
create table if not exists public.deals (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists deals_updated_idx on public.deals (updated_at desc);
alter table public.deals enable row level security;
revoke all on public.deals from anon, authenticated;
