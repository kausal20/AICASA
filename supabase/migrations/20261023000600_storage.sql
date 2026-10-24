-- Private document storage. Object keys are "<institution_id>/<random uuid>.<ext>"; the original
-- filename is metadata only. No public URLs: downloads use short-lived signed URLs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('institution-documents', 'institution-documents', false, 10485760,
        array['application/pdf', 'image/png', 'image/jpeg', 'text/plain'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function app.storage_institution(p_name text) returns uuid
language plpgsql immutable as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end $$;

-- Upload: only representatives, only into their own institution folder, only uuid-shaped keys.
create policy institution_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'institution-documents'
    and name ~ '^[0-9a-f-]{36}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,5})?$'
    and app.is_representative_of(app.storage_institution(name))
  );

-- Read: anyone who may read the institution's records (members, explicit grants, regional staff).
create policy institution_read on storage.objects for select to authenticated
  using (bucket_id = 'institution-documents' and app.can_read_institution(app.storage_institution(name)));

-- No update or delete policies: stored versions are immutable evidence.
