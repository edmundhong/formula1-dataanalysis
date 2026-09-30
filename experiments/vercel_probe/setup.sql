-- Disposable destinations for the copied publisher. Run once, never in migrations.
create table public.probe20260928_sessions (like public.sessions including defaults including constraints including indexes);
create table public.probe20260928_jobs (like public.ingestion_jobs including defaults including constraints including indexes);
create table public.probe20260928_state (like public.ingestion_state including defaults including constraints including indexes);
alter table public.probe20260928_sessions enable row level security;
alter table public.probe20260928_jobs enable row level security;
alter table public.probe20260928_state enable row level security;
revoke all on public.probe20260928_sessions, public.probe20260928_jobs, public.probe20260928_state from anon, authenticated;
grant all on public.probe20260928_sessions, public.probe20260928_jobs, public.probe20260928_state to service_role;
grant select on public.probe20260928_sessions to anon, authenticated;
create policy probe_read on public.probe20260928_sessions for select to anon, authenticated using (true);
insert into public.probe20260928_sessions select * from public.sessions where id = '2026-01-Q';
update public.probe20260928_sessions set artifact_path = null, version = null, updated_at = null, status = 'waiting';
insert into public.probe20260928_jobs(session_id) values ('2026-01-Q');
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('probe20260928-analysis', 'probe20260928-analysis', true, 12582912, array['application/json']);
