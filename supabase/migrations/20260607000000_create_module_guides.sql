create table if not exists public.module_guides (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.modules(id) on delete cascade,
  title text not null,
  description text,
  guide_text text,
  file_url text,
  file_path text,
  file_name text,
  file_mime_type text,
  file_size_bytes bigint,
  version integer not null default 1,
  is_published boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint module_guides_one_per_module unique (module_id),
  constraint module_guides_has_content check (
    guide_text is not null
    or file_url is not null
    or file_path is not null
  ),
  constraint module_guides_version_positive check (version > 0),
  constraint module_guides_file_size_positive check (
    file_size_bytes is null
    or file_size_bytes >= 0
  )
);

create index if not exists module_guides_module_id_idx
  on public.module_guides(module_id);

create index if not exists module_guides_is_published_idx
  on public.module_guides(is_published);

create or replace function public.set_module_guides_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_module_guides_updated_at on public.module_guides;

create trigger trg_module_guides_updated_at
before update on public.module_guides
for each row
execute function public.set_module_guides_updated_at();

alter table public.module_guides enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'module_guides'
      and policyname = 'Students can read published module guides'
  ) then
    create policy "Students can read published module guides"
      on public.module_guides
      for select
      to authenticated
      using (
        is_published = true
        and (
          exists (
            select 1
            from public.profiles p
            where p.id = auth.uid()
              and p.role = 'admin'
          )
          or exists (
            select 1
            from public.enrollments e
            where e.student_id = auth.uid()
              and e.module_id = module_guides.module_id
          )
        )
      );
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'module_guides'
      and policyname = 'Admins can manage module guides'
  ) then
    create policy "Admins can manage module guides"
      on public.module_guides
      for all
      to authenticated
      using (
        exists (
          select 1
          from public.profiles p
          where p.id = auth.uid()
            and p.role = 'admin'
        )
      )
      with check (
        exists (
          select 1
          from public.profiles p
          where p.id = auth.uid()
            and p.role = 'admin'
        )
      );
  end if;
end;
$$;
