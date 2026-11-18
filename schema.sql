-- TaxiBook India — Supabase PostgreSQL Schema & Row-Level Security
-- Run this script once in your Supabase Dashboard -> SQL Editor

create extension if not exists pgcrypto;

-- 1. Rider Profiles Table (synced on Signup & Login)
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  email text not null unique,
  default_phone text not null default '',
  role text not null default 'rider' check (role in ('rider')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Taxi Bookings & Dispatch Ledger
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  booking_code text not null unique,
  passenger_name text not null,
  passenger_phone text not null,
  vehicle text not null check (vehicle in ('bike', 'auto', 'car')),
  pickup_lat double precision not null,
  pickup_lng double precision not null,
  pickup_label text not null,
  dest_lat double precision not null,
  dest_lng double precision not null,
  dest_label text not null,
  distance_km double precision not null,
  duration_min double precision not null,
  base_fare double precision not null,
  per_km_rate double precision not null,
  fare_inr double precision not null,
  driver_name text not null,
  driver_phone text not null,
  plate_number text not null,
  status text not null default 'dispatched' check (status in ('dispatched', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes for fast owner-scoped queries
create index if not exists idx_bookings_user_id on public.bookings(user_id);
create index if not exists idx_bookings_created_at on public.bookings(created_at desc);

-- Automatically insert/update public.users whenever someone signs up via Supabase Auth
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, display_name, email, role, created_at, updated_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    coalesce(new.email, ''),
    'rider',
    now(),
    now()
  )
  on conflict (id) do update
    set email = excluded.email,
        display_name = coalesce(nullif(excluded.display_name, ''), public.users.display_name),
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Enable Row-Level Security (RLS)
alter table public.users enable row level security;
alter table public.bookings enable row level security;

-- Users policies: riders can view/insert/update only their own row
drop policy if exists "Users can view own profile" on public.users;
create policy "Users can view own profile"
  on public.users for select
  to authenticated
  using (auth.uid() = id);

drop policy if exists "Users can insert own profile" on public.users;
create policy "Users can insert own profile"
  on public.users for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "Users can update own profile" on public.users;
create policy "Users can update own profile"
  on public.users for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Bookings policies: riders can manage only their own rides
drop policy if exists "Users can view own bookings" on public.bookings;
create policy "Users can view own bookings"
  on public.bookings for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own bookings" on public.bookings;
create policy "Users can insert own bookings"
  on public.bookings for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own bookings" on public.bookings;
create policy "Users can update own bookings"
  on public.bookings for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own bookings" on public.bookings;
create policy "Users can delete own bookings"
  on public.bookings for delete
  to authenticated
  using (auth.uid() = user_id);
