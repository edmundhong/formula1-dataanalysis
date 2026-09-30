-- Remove the temporary pilot allowlist from admission. Keep the legacy column
-- for a safe rolling deployment: existing Cron SQL can run until its updated
-- definition is installed, while this function already accepts all of 2026.

create or replace function public.enqueue_analysis(p_session text, p_client text) returns jsonb
language plpgsql set search_path = '' as $$
declare s public.sessions; j public.analysis_queue; c public.analysis_control; n integer;
begin
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
  if not found or s.year <> 2026 or s.status = 'cancelled' or s.starts_at +
    (case s.code when 'R' then interval '3 hours' when 'S' then interval '90 minutes' when 'SQ' then interval '90 minutes' else interval '2 hours' end) > now()
    then return jsonb_build_object('result','ineligible'); end if;
  if s.artifact_path is not null then return jsonb_build_object('result','available'); end if;
  select * into j from public.analysis_queue where session_id = s.id;
  if found then return jsonb_build_object('result','existing','job',jsonb_build_object('state',j.state,'attempts',j.attempts,'last_attempt_at',j.last_attempt_at,'next_attempt_at',j.next_attempt_at,'error_code',j.error_code)); end if;
  if (select count(*) from public.analysis_queue where state in ('queued','retry','processing')) >= 20 then return jsonb_build_object('result','limited'); end if;
  insert into public.analysis_queue(session_id) values(s.id) returning * into j;
  return jsonb_build_object('result','queued','job',jsonb_build_object('state',j.state,'attempts',j.attempts,'last_attempt_at',j.last_attempt_at,'next_attempt_at',j.next_attempt_at,'error_code',j.error_code));
end $$;

create or replace function public.claim_analysis() returns jsonb
language plpgsql set search_path = '' as $$
declare j public.analysis_queue; c public.analysis_control;
begin
  perform pg_advisory_xact_lock(26092901);
  select * into c from public.analysis_control where id for update;
  if not c.enabled then return null; end if;
  update public.analysis_queue set state = case when attempts >= 5 then 'failed' else 'retry' end,
    error_code = 'lease_expired', lease_token = null, lease_expires_at = null,
    next_attempt_at = now() + least(interval '24 hours', interval '15 minutes' * power(2, attempts - 1))
    where state = 'processing' and lease_expires_at < now();
  insert into public.analysis_alerts(session_id,error_code,attempts)
    select session_id,error_code,attempts from public.analysis_queue where state in ('retry','failed') and attempts >= 3
    on conflict(session_id) do nothing;
  if exists(select 1 from public.analysis_queue where state = 'processing') then return null; end if;
  if c.budget_day <> current_date then update public.analysis_control set budget_day = current_date, daily_attempts = 0 where id; c.daily_attempts := 0; end if;
  if c.daily_attempts >= c.daily_limit then return null; end if;
  select q.* into j from public.analysis_queue q join public.sessions s on s.id = q.session_id
    where q.state in ('queued','retry') and q.next_attempt_at <= now() and s.year = 2026 and s.status <> 'cancelled'
      and s.starts_at + (case s.code when 'R' then interval '3 hours' when 'S' then interval '90 minutes' when 'SQ' then interval '90 minutes' else interval '2 hours' end) <= now()
    order by q.next_attempt_at, q.queued_at limit 1 for update of q;
  if not found then return null; end if;
  update public.analysis_queue set state='processing', attempts=attempts+1, last_attempt_at=now(), heartbeat_at=now(), lease_token=gen_random_uuid(), lease_expires_at=now()+interval '6 minutes' where session_id=j.session_id returning * into j;
  update public.analysis_control set daily_attempts=daily_attempts+1 where id;
  return jsonb_build_object('session', (select to_jsonb(s) from public.sessions s where s.id=j.session_id), 'lease_token',j.lease_token);
end $$;
