-- Run this once in the Supabase SQL editor.
create table if not exists public.bot_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- RLS on with NO policies on purpose: the public anon key can read/write nothing.
-- Only the server-side secret/service key (which bypasses RLS) can touch this table.
alter table public.bot_state enable row level security;
