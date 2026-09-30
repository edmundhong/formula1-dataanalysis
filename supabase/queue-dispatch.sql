-- Install after the queue migration. Run as postgres, not through the public API.
-- Set Vault secrets f1_worker_url and f1_worker_token first.
-- Alert delivery is opt-in via analysis_control.alerts_enabled and f1_owner_alert_url.
-- The alert URL must be an owner-controlled JSON webhook (never a browser input).
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
alter table public.analysis_control add column if not exists alerts_enabled boolean not null default false;
alter table public.analysis_alerts add column if not exists request_id bigint;
alter table public.analysis_alerts add column if not exists requested_at timestamptz;

create or replace function public.dispatch_analysis() returns void
language plpgsql set search_path = '' as $$
declare worker_url text; worker_token text; alert_url text; alert_row record; request bigint;
begin
  perform pg_advisory_xact_lock(26092901);
  if not exists(select 1 from public.analysis_control where id and enabled) then return; end if;
  select decrypted_secret into worker_url from vault.decrypted_secrets where name='f1_worker_url';
  select decrypted_secret into worker_token from vault.decrypted_secrets where name='f1_worker_token';
  select decrypted_secret into alert_url from vault.decrypted_secrets where name='f1_owner_alert_url';
  if worker_url is null or worker_token is null then return; end if;
  -- Missing sessions enter the queue only when a visitor selects one. Preserve
  -- the 24-hour and seven-day correction passes for already published data.
  update public.analysis_queue q set state='queued',attempts=0,queued_at=now(),next_attempt_at=now()
    where q.session_id in (
      select s.id from public.sessions s join public.ingestion_jobs j on j.session_id=s.id
      join public.analysis_queue a on a.session_id=s.id
      where a.state='succeeded' and s.year=2026 and s.status<>'cancelled'
        and j.last_checked_at<now()-interval '23 hours'
        and ((j.correction_stage<1 and s.starts_at<now()-interval '27 hours')
          or (j.correction_stage<2 and s.starts_at<now()-interval '7 days 3 hours'))
      order by j.last_checked_at limit greatest(0,20-(select count(*)::int from public.analysis_queue where state in ('queued','retry','processing')))
    );
  -- A durable due row is the outbox. pg_net is merely a delivery attempt;
  -- lost HTTP requests are retried by the next sweep, including after DB restart.
  if exists(select 1 from public.analysis_control where id
      and (last_dispatch_at is null or last_dispatch_at < now()-interval '6 minutes')
      and (budget_day<>current_date or daily_attempts<daily_limit))
    and not exists(select 1 from public.analysis_queue where state='processing' and lease_expires_at>now())
    and exists(select 1 from public.analysis_queue where
      (state in ('queued','retry') and next_attempt_at<=now()) or (state='processing' and lease_expires_at<=now())) then
    perform net.http_post(url:=worker_url, headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||worker_token), body:='{}'::jsonb, timeout_milliseconds:=280000);
    update public.analysis_control set last_dispatch_at=now() where id;
  end if;
  -- Processing is independent of notifications. Keep durable failures for inspection.
  if alert_url is null or not exists(select 1 from public.analysis_control where id and alerts_enabled) then return; end if;
  update public.analysis_alerts a set delivered_at=now() from net._http_response r
    where a.request_id=r.id and a.delivered_at is null and r.status_code between 200 and 299;
  for alert_row in select * from public.analysis_alerts where delivered_at is null
    and (requested_at is null or requested_at<now()-interval '1 hour') limit 10 loop
    request := net.http_post(url:=alert_url, headers:='{"Content-Type":"application/json"}'::jsonb,
      body:=jsonb_build_object('text','F1 analysis needs attention: '||alert_row.session_id||' ('||alert_row.error_code||')',
        'session_id',alert_row.session_id,'error_code',alert_row.error_code,'attempts',alert_row.attempts), timeout_milliseconds:=10000);
    update public.analysis_alerts set request_id=request,requested_at=now() where session_id=alert_row.session_id;
  end loop;
end $$;
revoke all on function public.dispatch_analysis() from public,anon,authenticated,service_role;
select cron.schedule('f1-analysis-dispatch','*/2 * * * *','select public.dispatch_analysis()');
