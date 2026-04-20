create table if not exists public.courses (
  course_id text primary key,
  course_name text not null,
  instructor text,
  status text not null default 'เปิดสอน',
  video_url text,
  material_link text,
  description text,
  created_at timestamptz not null default now()
);

alter table public.courses enable row level security;

create policy "authenticated users can read courses"
on public.courses
for select
to authenticated
using (true);

create policy "admins can insert courses"
on public.courses
for insert
to authenticated
with check (
  exists (
    select 1
    from public.users_profile
    where users_profile.id = auth.uid()
      and users_profile.role = 'admin'
  )
);

create policy "admins can update courses"
on public.courses
for update
to authenticated
using (
  exists (
    select 1
    from public.users_profile
    where users_profile.id = auth.uid()
      and users_profile.role = 'admin'
  )
)
with check (
  exists (
    select 1
    from public.users_profile
    where users_profile.id = auth.uid()
      and users_profile.role = 'admin'
  )
);

create policy "admins can delete courses"
on public.courses
for delete
to authenticated
using (
  exists (
    select 1
    from public.users_profile
    where users_profile.id = auth.uid()
      and users_profile.role = 'admin'
  )
);
