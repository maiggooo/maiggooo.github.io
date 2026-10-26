-- Reisekarte backend. Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to read: it contains no secrets. Every table has row-level security, so the public
-- (anon) key in the website can only read published trips and change the signed-in user's own data.

-- ————————————— Profiles: one per account, created automatically on sign-up —————————————
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  handle text unique check (handle ~ '^[a-z0-9_]{3,24}$'),  -- used in links: #u=handle
  name text,
  avatar_url text,
  bio text,
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ————————————— Trips and stops —————————————
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references public.profiles on delete cascade,
  slug text not null,                       -- used in links: #trip=slug
  title text not null default 'Neue Reise',
  start_date date,
  end_date date,
  summary text not null default '',
  tags text[] not null default '{}',
  countries text[] not null default '{}',
  cover text,                               -- photo URL
  legs jsonb not null default '[]',         -- [{ mode, coords? }], legs[i] = stop i → i+1
  published boolean not null default false, -- drafts are only visible to their owner
  created_at timestamptz not null default now(),
  unique (slug)                             -- global, so #trip=slug links are unambiguous
);

create table public.stops (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips on delete cascade,
  position int not null,                    -- order within the trip
  name text not null,
  lng double precision not null,
  lat double precision not null,
  cc text,                                  -- country code, e.g. PT
  visited_at timestamp,                     -- local time at the place, no time zone
  md text not null default '',
  rating smallint check (rating between 1 and 5),
  photos jsonb not null default '[]',       -- [{ src, alt, lngLat, time }]
  videos jsonb not null default '[]',       -- [{ url, title }]
  costs jsonb not null default '[]',        -- [{ amount, cur, cat, note }]
  created_at timestamptz not null default now()  -- the feed sorts by this
);
create index stops_trip_position on public.stops (trip_id, position);
create index stops_created on public.stops (created_at desc);

-- ————————————— Follows —————————————
create table public.follows (
  follower uuid not null default auth.uid() references public.profiles on delete cascade,
  followee uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, followee),
  check (follower <> followee)
);

-- ————————————— Row-level security —————————————
alter table public.profiles enable row level security;
alter table public.trips enable row level security;
alter table public.stops enable row level security;
alter table public.follows enable row level security;

create policy "profiles are public" on public.profiles for select using (true);
create policy "edit own profile" on public.profiles for update
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "read published or own trips" on public.trips for select
  using (published or owner = (select auth.uid()));
create policy "create own trips" on public.trips for insert
  with check (owner = (select auth.uid()));
create policy "edit own trips" on public.trips for update
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "delete own trips" on public.trips for delete
  using (owner = (select auth.uid()));

create policy "read stops of visible trips" on public.stops for select
  using (exists (select 1 from public.trips t where t.id = trip_id and (t.published or t.owner = (select auth.uid()))));
create policy "create stops in own trips" on public.stops for insert
  with check (exists (select 1 from public.trips t where t.id = trip_id and t.owner = (select auth.uid())));
create policy "edit stops in own trips" on public.stops for update
  using (exists (select 1 from public.trips t where t.id = trip_id and t.owner = (select auth.uid())))
  with check (exists (select 1 from public.trips t where t.id = trip_id and t.owner = (select auth.uid())));
create policy "delete stops in own trips" on public.stops for delete
  using (exists (select 1 from public.trips t where t.id = trip_id and t.owner = (select auth.uid())));

create policy "follows are public" on public.follows for select using (true);
create policy "follow as yourself" on public.follows for insert with check (follower = (select auth.uid()));
create policy "unfollow as yourself" on public.follows for delete using (follower = (select auth.uid()));

grant select on public.profiles, public.trips, public.stops, public.follows to anon, authenticated;
grant update on public.profiles to authenticated;
grant insert, update, delete on public.trips, public.stops to authenticated;
grant insert, delete on public.follows to authenticated;

-- ————————————— Photo storage: public to view, each user uploads into their own folder —————————————
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/webp', 'image/jpeg'])
on conflict (id) do nothing;

create policy "upload into own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "delete from own folder" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ————————————— Live updates for the feed —————————————
alter publication supabase_realtime add table public.stops;

-- ————————————— Profiles for accounts that existed before this script ran —————————————
insert into public.profiles (id, name)
select id, coalesce(raw_user_meta_data ->> 'name', split_part(email, '@', 1)) from auth.users
on conflict (id) do nothing;
