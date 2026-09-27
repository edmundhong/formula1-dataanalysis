create table public.sessions (
  id text primary key check (id ~ '^[0-9]{4}-[0-9]{2}-(FP[123]|Q|SQ|S|R)$'),
  year integer not null check (year >= 2026), round integer not null check (round > 0),
  event text not null, country text not null, location text not null,
  code text not null, name text not null, starts_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','waiting','available','partial','delayed','cancelled')),
  artifact_path text, version text, updated_at timestamptz
);
create index sessions_schedule on public.sessions (year, starts_at desc);
alter table public.sessions enable row level security;
revoke all on public.sessions from anon, authenticated;
grant select on public.sessions to anon, authenticated;
grant all on public.sessions to service_role;
create policy "Read session catalog" on public.sessions for select to anon, authenticated using (year >= 2026);

create table public.ingestion_jobs (
  session_id text primary key references public.sessions(id) on delete cascade,
  last_checked_at timestamptz, correction_stage integer not null default 0,
  last_error text, artifact_bytes bigint not null default 0
);
alter table public.ingestion_jobs enable row level security;
revoke all on public.ingestion_jobs from anon, authenticated;
grant all on public.ingestion_jobs to service_role;

create table public.ingestion_state (
  key text primary key, value text not null
);
alter table public.ingestion_state enable row level security;
revoke all on public.ingestion_state from anon, authenticated;
grant all on public.ingestion_state to service_role;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('analysis','analysis',true,12582912,array['application/json'])
on conflict (id) do nothing;
-- Public downloads contain only published F1 data. No client write policies.
