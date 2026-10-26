-- Missing sessions migrate to OpenF1; existing immutable FastF1 publications stay.
alter table public.sessions add column analysis_provider text check (analysis_provider in ('FastF1','OpenF1'));
alter table public.sessions add column openf1_session_key bigint;
alter table public.sessions add column openf1_meeting_key bigint;
update public.sessions set analysis_provider='FastF1' where artifact_path is not null;
alter table public.analysis_control add column openf1_enabled boolean not null default false;
alter table public.analysis_control add column openf1_sessions text[] default array['2026-18-Q'];
alter table public.analysis_queue add column invocations integer not null default 0;
alter table public.analysis_queue add column progress jsonb not null default '{}'::jsonb;
alter table public.analysis_queue add column checkpoint_reserved bigint not null default 0;

create table public.analysis_checkpoints (
  session_id text primary key references public.sessions(id) on delete cascade,
  path text not null unique, sha256 text not null, bytes bigint not null,
  source jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.analysis_checkpoints enable row level security;
revoke all on public.analysis_checkpoints from public,anon,authenticated;
grant all on public.analysis_checkpoints to service_role;
create table public.analysis_uploads (
  session_id text not null references public.sessions(id) on delete cascade,
  version text not null, file text not null, bytes bigint not null, sha256 text not null, laps jsonb not null,
  verified_at timestamptz not null default now(), primary key(session_id,version,file)
);
alter table public.analysis_uploads enable row level security;
revoke all on public.analysis_uploads from public,anon,authenticated;
grant all on public.analysis_uploads to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('analysis-checkpoints','analysis-checkpoints',false,50331648,array['application/gzip']) on conflict(id) do nothing;

create or replace function public.analysis_storage_bytes() returns bigint
language sql set search_path = '' as $$
  select coalesce(sum((metadata->>'size')::bigint),0)::bigint from storage.objects
    where bucket_id in ('analysis','analysis-checkpoints');
$$;

drop function public.claim_analysis();
create function public.claim_analysis(p_openf1 boolean default false) returns jsonb
language plpgsql set search_path = '' as $$
declare j public.analysis_queue; c public.analysis_control;
begin
  perform pg_advisory_xact_lock(26092901);
  select * into c from public.analysis_control where id for update;
  if not c.enabled or not c.openf1_enabled or not p_openf1 then return null; end if;
  update public.analysis_queue set state=case when attempts>=5 then 'failed' else 'retry' end,
    error_code='lease_expired',lease_token=null,lease_expires_at=null,checkpoint_reserved=0,
    next_attempt_at=now()+least(interval '24 hours',interval '15 minutes'*power(2,greatest(0,attempts-1)))
    where state='processing' and lease_expires_at<now();
  insert into public.analysis_alerts(session_id,error_code,attempts)
    select session_id,error_code,attempts from public.analysis_queue where state in ('retry','failed') and attempts>=3
    on conflict(session_id) do nothing;
  if exists(select 1 from public.analysis_queue where state='processing') then return null; end if;
  if c.budget_day<>current_date then
    update public.analysis_control set budget_day=current_date,daily_attempts=0 where id;
    c.daily_attempts:=0;
  end if;
  if c.daily_attempts>=c.daily_limit then return null; end if;
  select q.* into j from public.analysis_queue q join public.sessions s on s.id=q.session_id
    where q.state in ('queued','retry') and q.next_attempt_at<=now() and s.year=2026 and s.status<>'cancelled'
      and (s.artifact_path is null or s.analysis_provider='OpenF1')
      and (c.openf1_sessions is null or s.id=any(c.openf1_sessions))
      and s.starts_at+(case s.code when 'R' then interval '3 hours' when 'S' then interval '90 minutes' when 'SQ' then interval '90 minutes' else interval '2 hours' end)<=now()
    order by q.next_attempt_at,q.queued_at limit 1 for update of q;
  if not found then return null; end if;
  delete from public.analysis_checkpoints where session_id=j.session_id and updated_at<now()-interval '7 days';
  update public.analysis_queue set state='processing',attempts=attempts+1,invocations=invocations+1,
    last_attempt_at=now(),heartbeat_at=now(),lease_token=gen_random_uuid(),lease_expires_at=now()+interval '6 minutes'
    where session_id=j.session_id returning * into j;
  update public.analysis_control set daily_attempts=daily_attempts+1 where id;
  update public.sessions set analysis_provider='OpenF1' where id=j.session_id and artifact_path is null;
  return jsonb_build_object('provider','OpenF1','session',(select to_jsonb(s) from public.sessions s where s.id=j.session_id),
    'lease_token',j.lease_token,'checkpoint',(select to_jsonb(p) from public.analysis_checkpoints p where session_id=j.session_id));
end $$;

create function public.reserve_analysis_checkpoint(p_session text,p_lease uuid,p_bytes bigint) returns boolean
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(26092901);
  if p_bytes<0 or p_bytes>50331648 then return false; end if;
  if public.analysis_storage_bytes()+p_bytes+(select coalesce(sum(checkpoint_reserved),0) from public.analysis_queue)>786432000 then return false; end if;
  update public.analysis_queue set checkpoint_reserved=p_bytes where session_id=p_session and lease_token=p_lease
    and state='processing' and lease_expires_at>now();
  return found;
end $$;

create function public.checkpoint_analysis(p_session text,p_lease uuid,p_bytes bigint,p_path text,p_sha256 text,
  p_progress jsonb,p_cooldown double precision,p_release boolean,p_source jsonb) returns boolean
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(26092901);
  perform 1 from public.analysis_queue where session_id=p_session and lease_token=p_lease and state='processing'
    and lease_expires_at>now() and checkpoint_reserved=p_bytes for update;
  if not found then return false; end if;
  if p_path<>p_session||'/'||p_lease::text||'/'||p_sha256||'.tar.gz' or p_sha256!~'^[a-f0-9]{64}$'
    or p_bytes<0 or p_bytes>50331648 or pg_column_size(p_progress)>1024 or pg_column_size(p_source)>8192 then return false; end if;
  insert into public.analysis_checkpoints(session_id,path,sha256,bytes,source) values(p_session,p_path,p_sha256,p_bytes,p_source)
    on conflict(session_id) do update set path=p_path,sha256=p_sha256,bytes=p_bytes,source=p_source,updated_at=now();
  update public.sessions set openf1_session_key=(p_source->>'session_key')::bigint,
    openf1_meeting_key=(p_source->>'meeting_key')::bigint where id=p_session and analysis_provider='OpenF1';
  update public.analysis_queue set progress=p_progress,checkpoint_reserved=0,
    state=case when p_release then 'queued' else state end,
    attempts=case when p_release then greatest(0,attempts-1) else attempts end,
    next_attempt_at=greatest(now()+interval '2.1 seconds',to_timestamp(p_cooldown)),
    lease_token=case when p_release then null else lease_token end,
    lease_expires_at=case when p_release then null else lease_expires_at end,
    error_code=null where session_id=p_session;
  return true;
end $$;

create function public.verified_analysis_files(p_session text,p_lease uuid,p_version text) returns text[]
language sql set search_path = '' as $$
  select coalesce(array_agg(u.file),array[]::text[]) from public.analysis_uploads u
  where u.session_id=p_session and u.version=p_version and exists(
    select 1 from public.analysis_queue q where q.session_id=p_session and q.lease_token=p_lease and q.state='processing' and q.lease_expires_at>now());
$$;

create function public.expired_analysis_checkpoints() returns text[]
language plpgsql set search_path = '' as $$
declare paths text[];
begin
  perform pg_advisory_xact_lock(26092901);
  delete from public.analysis_uploads u where verified_at<now()-interval '7 days'
    and not exists(select 1 from public.sessions s where s.id=u.session_id and s.version=u.version)
    and not exists(select 1 from public.analysis_queue q where q.session_id=u.session_id and q.state='processing' and q.lease_expires_at>now());
  delete from public.analysis_checkpoints p where updated_at<now()-interval '7 days'
    and not exists(select 1 from public.analysis_queue q where q.session_id=p.session_id and q.state='processing' and q.lease_expires_at>now());
  select array_agg(name) into paths from (select o.name from storage.objects o where o.bucket_id='analysis-checkpoints'
    and o.created_at<now()-interval '10 minutes'
    and not exists(select 1 from public.analysis_checkpoints p where p.path=o.name)
    order by o.created_at limit 100) expired;
  return coalesce(paths,array[]::text[]);
end $$;

create or replace function public.fail_analysis(p_session text,p_lease uuid,p_error text) returns boolean
language plpgsql set search_path = '' as $$
declare j public.analysis_queue;
begin
  update public.analysis_queue set state=case when attempts>=5 then 'failed' else 'retry' end,
    error_code=p_error,lease_token=null,lease_expires_at=null,checkpoint_reserved=0,
    next_attempt_at=now()+least(interval '24 hours',interval '15 minutes'*power(2,greatest(0,attempts-1)))
    where session_id=p_session and lease_token=p_lease and state='processing' and lease_expires_at>now() returning * into j;
  if not found then return false; end if;
  if j.attempts>=3 then
    insert into public.analysis_alerts(session_id,error_code,attempts) values(p_session,p_error,j.attempts) on conflict(session_id) do nothing;
  end if;
  return true;
end $$;

-- Keep the existing atomic publisher behind a provider/lease compatibility guard.
alter function public.publish_analysis(text,uuid,text,text,boolean,bigint,integer) rename to commit_analysis;
revoke all on function public.commit_analysis(text,uuid,text,text,boolean,bigint,integer) from public,anon,authenticated,service_role;
-- Invoker wrapper requires service_role to execute the inner function too.
grant execute on function public.commit_analysis(text,uuid,text,text,boolean,bigint,integer) to service_role;
create function public.publish_analysis(p_session text,p_lease uuid,p_path text,p_version text,p_partial boolean,p_bytes bigint,p_stage integer) returns boolean
language plpgsql set search_path = '' as $$
declare result boolean;
begin
  perform pg_advisory_xact_lock(26092901);
  if exists(select 1 from public.sessions where id=p_session and artifact_path is not null and analysis_provider='FastF1') then return false; end if;
  result:=public.commit_analysis(p_session,p_lease,p_path,p_version,p_partial,p_bytes,p_stage);
  if result then
    delete from public.analysis_checkpoints where session_id=p_session;
    update public.analysis_queue set progress='{"stage":"published"}',checkpoint_reserved=0 where session_id=p_session;
  end if;
  return result;
end $$;

revoke all on function public.verified_analysis_files(text,uuid,text),public.claim_analysis(boolean),public.reserve_analysis_checkpoint(text,uuid,bigint),
 public.checkpoint_analysis(text,uuid,bigint,text,text,jsonb,double precision,boolean,jsonb),public.expired_analysis_checkpoints(),
 public.publish_analysis(text,uuid,text,text,boolean,bigint,integer) from public,anon,authenticated;
grant execute on function public.verified_analysis_files(text,uuid,text),public.claim_analysis(boolean),public.reserve_analysis_checkpoint(text,uuid,bigint),
 public.checkpoint_analysis(text,uuid,bigint,text,text,jsonb,double precision,boolean,jsonb),public.expired_analysis_checkpoints(),
 public.publish_analysis(text,uuid,text,text,boolean,bigint,integer) to service_role;
