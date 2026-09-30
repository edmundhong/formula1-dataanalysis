-- All RPCs are service-only SECURITY INVOKER. Browsers use the bounded server API.
create table public.analysis_queue (
  session_id text primary key references public.sessions(id) on delete cascade,
  state text not null default 'queued' check (state in ('queued','processing','retry','failed','succeeded')),
  attempts integer not null default 0,
  queued_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid, lease_expires_at timestamptz, heartbeat_at timestamptz,
  error_code text check (error_code in ('source_unavailable','resource_exhaustion','worker_failure','lease_expired','publication_failed'))
);
create index analysis_queue_due on public.analysis_queue(next_attempt_at, queued_at) where state in ('queued','retry');
create table public.analysis_clients (client_hash text primary key, window_start timestamptz not null, requests integer not null);
create table public.analysis_control (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  allowed_sessions text[] not null default array['2026-01-Q','2026-12-R'],
  daily_limit integer not null default 12 check (daily_limit between 1 and 100),
  budget_day date not null default current_date, daily_attempts integer not null default 0,
  last_dispatch_at timestamptz
);
insert into public.analysis_control(id) values (true);
create table public.analysis_alerts (
  session_id text primary key references public.sessions(id) on delete cascade,
  error_code text not null, attempts integer not null, created_at timestamptz not null default now(),
  delivered_at timestamptz
);
alter table public.analysis_queue enable row level security;
alter table public.analysis_clients enable row level security;
alter table public.analysis_control enable row level security;
alter table public.analysis_alerts enable row level security;
revoke all on public.analysis_queue, public.analysis_clients, public.analysis_control, public.analysis_alerts from public, anon, authenticated;
grant all on public.analysis_queue, public.analysis_clients, public.analysis_control, public.analysis_alerts to service_role;

create function public.enqueue_analysis(p_session text, p_client text) returns jsonb
language plpgsql set search_path = '' as $$
declare s public.sessions; j public.analysis_queue; c public.analysis_control; n integer;
begin
  -- Serializes rate limits, deduplication, capacity and claims across instances.
  perform pg_advisory_xact_lock(26092901);
  select * into c from public.analysis_control where id;
  if not c.enabled then return jsonb_build_object('result','ineligible'); end if;
  if p_client is null or p_client !~ '^[a-f0-9]{64}$' then raise exception 'Invalid client hash'; end if;
  delete from public.analysis_clients where window_start < now() - interval '2 hours';
  insert into public.analysis_clients values (p_client, now(), 1)
  on conflict (client_hash) do update set
    requests = case when analysis_clients.window_start < now() - interval '1 hour' then 1 else analysis_clients.requests + 1 end,
    window_start = case when analysis_clients.window_start < now() - interval '1 hour' then now() else analysis_clients.window_start end
  returning requests into n;
  if n > 6 then return jsonb_build_object('result','limited'); end if;
  select * into s from public.sessions where id = p_session;
  if not found or s.status = 'cancelled' or s.starts_at +
    (case s.code when 'R' then interval '3 hours' when 'S' then interval '90 minutes' when 'SQ' then interval '90 minutes' else interval '2 hours' end) > now()
    or not (s.id = any(c.allowed_sessions)) then return jsonb_build_object('result','ineligible'); end if;
  if s.artifact_path is not null then return jsonb_build_object('result','available'); end if;
  select * into j from public.analysis_queue where session_id = s.id;
  if found then
    -- Visitors cannot reset retries, bypass cooldowns, or revive terminal failures.
    return jsonb_build_object('result','existing','job',jsonb_build_object('state',j.state,'attempts',j.attempts,'last_attempt_at',j.last_attempt_at,'next_attempt_at',j.next_attempt_at,'error_code',j.error_code));
  end if;
  if (select count(*) from public.analysis_queue where state in ('queued','retry','processing')) >= 20 then
    return jsonb_build_object('result','limited');
  end if;
  insert into public.analysis_queue(session_id) values(s.id) returning * into j;
  return jsonb_build_object('result','queued','job',jsonb_build_object('state',j.state,'attempts',j.attempts,'last_attempt_at',j.last_attempt_at,'next_attempt_at',j.next_attempt_at,'error_code',j.error_code));
end $$;

create function public.claim_analysis() returns jsonb
language plpgsql set search_path = '' as $$
declare j public.analysis_queue; c public.analysis_control;
begin
  perform pg_advisory_xact_lock(26092901);
  select * into c from public.analysis_control where id for update;
  if not c.enabled then return null; end if;
  -- Lease is longer than Vercel's hard 300-second lifetime, even without heartbeat.
  update public.analysis_queue set state = case when attempts >= 5 then 'failed' else 'retry' end,
    error_code = 'lease_expired', lease_token = null, lease_expires_at = null,
    next_attempt_at = now() + least(interval '24 hours', interval '15 minutes' * power(2, attempts - 1))
    where state = 'processing' and lease_expires_at < now();
  insert into public.analysis_alerts(session_id,error_code,attempts)
    select session_id,error_code,attempts from public.analysis_queue where state in ('retry','failed') and attempts >= 3
    on conflict(session_id) do nothing;
  if exists(select 1 from public.analysis_queue where state = 'processing') then return null; end if;
  if c.budget_day <> current_date then
    update public.analysis_control set budget_day = current_date, daily_attempts = 0 where id;
    c.daily_attempts := 0;
  end if;
  if c.daily_attempts >= c.daily_limit then return null; end if;
  -- Old and recent failures compete on due time; no seven-day age cutoff.
  select q.* into j from public.analysis_queue q join public.sessions s on s.id = q.session_id
    where q.state in ('queued','retry') and q.next_attempt_at <= now()
      and s.id = any(c.allowed_sessions) and s.status <> 'cancelled'
      and s.starts_at + (case s.code when 'R' then interval '3 hours' when 'S' then interval '90 minutes' when 'SQ' then interval '90 minutes' else interval '2 hours' end) <= now()
    order by q.next_attempt_at, q.queued_at limit 1 for update of q;
  if not found then return null; end if;
  update public.analysis_queue set state='processing', attempts=attempts+1,
    last_attempt_at=now(), heartbeat_at=now(), lease_token=gen_random_uuid(), lease_expires_at=now()+interval '6 minutes'
    where session_id=j.session_id returning * into j;
  update public.analysis_control set daily_attempts=daily_attempts+1 where id;
  return jsonb_build_object('session', (select to_jsonb(s) from public.sessions s where s.id=j.session_id), 'lease_token',j.lease_token);
end $$;

create function public.heartbeat_analysis(p_session text, p_lease uuid) returns boolean
language sql set search_path = '' as $$
  with renewed as (update public.analysis_queue set heartbeat_at=now(),
    lease_expires_at=greatest(lease_expires_at, now()+interval '90 seconds')
    where session_id=p_session and lease_token=p_lease and state='processing' and lease_expires_at>now() returning 1)
  select exists(select 1 from renewed);
$$;

create function public.fail_analysis(p_session text, p_lease uuid, p_error text) returns boolean
language plpgsql set search_path = '' as $$
declare j public.analysis_queue;
begin
  update public.analysis_queue set state=case when attempts>=5 then 'failed' else 'retry' end,
    error_code=p_error, lease_token=null, lease_expires_at=null,
    next_attempt_at=now()+least(interval '24 hours', interval '15 minutes'*power(2,attempts-1))
    where session_id=p_session and lease_token=p_lease and state='processing' and lease_expires_at>now() returning * into j;
  if not found then return false; end if;
  if j.attempts>=3 then
    insert into public.analysis_alerts(session_id,error_code,attempts) values(p_session,p_error,j.attempts)
    on conflict(session_id) do nothing;
  end if;
  return true;
end $$;

create function public.publish_analysis(p_session text, p_lease uuid, p_path text, p_version text,
  p_partial boolean, p_bytes bigint, p_stage integer) returns boolean
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(26092901);
  -- Legacy manual publications participate in the same lock as queue admission.
  if p_lease is null then
    if exists(select 1 from public.analysis_queue where session_id=p_session) then return false; end if;
  else
    perform 1 from public.analysis_queue where session_id=p_session and lease_token=p_lease
      and state='processing' and lease_expires_at>now() for update;
    if not found then return false; end if;
  end if;
  perform 1 from public.sessions where id=p_session and status<>'cancelled'
    and starts_at + (case code when 'R' then interval '3 hours' when 'S' then interval '90 minutes' when 'SQ' then interval '90 minutes' else interval '2 hours' end)<=now() for update;
  if not found then return false; end if;
  update public.sessions set artifact_path=p_path,version=p_version,updated_at=now(),
    status=case when p_partial then 'partial' else 'available' end where id=p_session;
  insert into public.ingestion_jobs(session_id,last_checked_at,correction_stage,last_error,artifact_bytes)
    values(p_session,now(),p_stage,null,p_bytes)
    on conflict(session_id) do update set last_checked_at=now(),correction_stage=p_stage,last_error=null,artifact_bytes=p_bytes;
  update public.analysis_queue set state='succeeded',lease_token=null,lease_expires_at=null,error_code=null where session_id=p_session;
  return true;
end $$;

revoke all on function public.enqueue_analysis(text,text), public.claim_analysis(), public.heartbeat_analysis(text,uuid), public.fail_analysis(text,uuid,text), public.publish_analysis(text,uuid,text,text,boolean,bigint,integer) from public,anon,authenticated;
grant execute on function public.enqueue_analysis(text,text), public.claim_analysis(), public.heartbeat_analysis(text,uuid), public.fail_analysis(text,uuid,text), public.publish_analysis(text,uuid,text,text,boolean,bigint,integer) to service_role;
