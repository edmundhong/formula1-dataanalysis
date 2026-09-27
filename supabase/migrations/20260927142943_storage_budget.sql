create function public.analysis_storage_bytes() returns bigint
language sql stable security invoker set search_path = ''
as $$ select coalesce(sum((metadata->>'size')::bigint),0)::bigint from storage.objects where bucket_id='analysis'; $$;
revoke all on function public.analysis_storage_bytes() from public, anon, authenticated;
grant execute on function public.analysis_storage_bytes() to service_role;
