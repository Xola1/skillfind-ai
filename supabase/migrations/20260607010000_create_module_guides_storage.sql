insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'module-guides',
  'module-guides',
  true,
  52428800,
  array['application/pdf']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Public can read module guide PDFs'
  ) then
    create policy "Public can read module guide PDFs"
      on storage.objects
      for select
      to public
      using (bucket_id = 'module-guides');
  end if;
end;
$$;
