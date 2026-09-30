# Durable Vercel analysis queue

The report's production follow-up is implemented with a Supabase database queue,
Supabase Cron dispatch, and a separate bounded Python Vercel deployment. No live
deployment or database change is performed by adding these files. The queue accepts
completed sessions from the 2026 calendar after it is enabled.

## Limits and delivery

- One active lease globally, protected by a transaction advisory lock. A six-minute
  lease outlives Vercel's 300-second hard limit. Heartbeat runs every 20 seconds.
- The analysis child is killed after 210 seconds. Database calls time out after
  10 seconds; publication after 25 seconds. A killed parent is recovered on a
  subsequent dispatch. Subprocesses receive no service/publisher credentials.
- Twenty queued/processing/retry jobs maximum; twelve attempts per database day
  by default, including retries. Five attempts per job, with exponential backoff
  starting at 15 minutes and capped at 24 hours. Historical jobs have no age cutoff.
- Anonymous requests: six per client per hour, HMAC of Vercel's trusted IP header,
  no raw IP storage, two-hour counter cleanup, same-origin checks, 256-character
  request limit. Visitors cannot reset cooldowns or terminal failures.
- Cron sweeps every two minutes and dispatches at most once per six minutes when
  work is due. Queue rows survive lost network deliveries and database restarts;
  `pg_net` is a delivery attempt, not the durable queue. No browser request waits
  for FastF1 and no unawaited promise does work.
- Scheduled admission is oldest-first within the explicit allowlist. Due jobs
  compete by retry time and queue time. Successful jobs retain the 24-hour and
  seven-day correction passes. The GitHub workflow only refreshes the calendar.
- Immutable uploads precede an atomic, lease-checked pointer/job commit. Manual
  legacy publishers cannot bypass an existing queued job. The previous artifact
  remains downloadable; publication failures retain the previous pointer.
- Three failed attempts create a durable owner alert. When alerts_enabled is true, dispatch sends only session,
  safe error category and attempt count to an owner-configured JSON webhook.
  Delivery is acknowledged only after a 2xx response; failures retry hourly.

## Deployment order

1. Run the queue migrations, including `20260930090000_enable_all_2026_session_requests.sql`,
   through the normal Supabase deployment process, then re-run
   `supabase/queue-dispatch.sql` to install its updated dispatcher. All tables have
   RLS and all RPCs are service-only, security-invoker functions. Run Supabase
   database advisors after applying them.
2. Deploy the updated `ingest` Edge Function before enabling workers. It now uses
   `publish_analysis` to fence and atomically commit publications.
3. Run `python worker/stage.py`. Deploy `.local/production-worker` as a **separate**
   Vercel project with Python 3.12, Fluid Compute, region `iad1`, 300 seconds and
   2,048 MiB. The staging script copies an allowlist, uses the pinned pipeline
   dependencies, and never copies local environment files or Vercel project links.
   Configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `F1_INGEST_URL`,
   `F1_INGEST_TOKEN`, and a random 32+ character `F1_WORKER_TOKEN` there.
   Set `F1_WORKER_ENABLED=1` only when configured. Use the production endpoint
   `/api/analysis`, reachable by Cron; application bearer authentication remains
   required. If deployment protection is enabled, configure an appropriate
   supported bypass before enabling dispatch.
4. In Supabase Vault create `f1_worker_url` (full HTTPS worker endpoint),
   `f1_worker_token`. Alerts default to disabled. Optionally create `f1_owner_alert_url` (an owner-approved JSON webhook).
   Install `supabase/queue-dispatch.sql` as postgres. It creates one named Cron job
   and reads secrets from Vault. No public role can invoke the dispatch function.
   Processing requires only the worker URL and token. Keep
   `analysis_control.alerts_enabled=false` to send no notifications. Configure and
   test an alert receiver before opting into alerts.
5. Deploy the dashboard with server-only `SUPABASE_SERVICE_ROLE_KEY`, a random
   `F1_CLIENT_HASH_SECRET`, `F1_PUBLIC_ORIGIN=https://edmundhong.com` (the browser
   origin, including the scheme), and `F1_QUEUE_ENABLED=1`. Existing public catalog keys
   remain unchanged. The API is under `/formula1-dataanalysis/api/jobs`.
6. Enable dispatch with `update public.analysis_control set enabled=true where id;`.
   Merge/enable the calendar-only workflow at this cutover. A completed, missing
   session is admitted automatically when a visitor selects it.
7. Verify several sessions: public artifact schema/counts, dashboard panels,
   queued → processing → succeeded, old pointer retained on a forced failure,
   recovery after terminating a worker, and owner alert receipt. Review actual
   Vercel/Supabase usage before increasing the daily budget. The queue cap and
   daily budget still apply.

Do not enable season-wide backfill before these live checks. Local tests validate
SQL and worker behavior; they cannot certify upstream access, deployed packaging,
Cron networking, or owner webhook delivery.

## Operations and rollback

Inspect `analysis_queue` for state, attempts, heartbeat, lease expiry and next due
time; inspect `analysis_alerts`, `cron.job_run_details` and `net._http_response` for
delivery. Error categories contain no raw upstream exception or credential.
Monitor dashboard API errors and Vercel usage as well as persistent job failures.

Pause new work with `update public.analysis_control set enabled=false where id;`
and set `F1_QUEUE_ENABLED=0`. An already running worker can finish its publication.
For immediate shutdown also disable the worker; leases then expire safely.
Existing artifacts and catalog reads remain available. Do not restore the old
GitHub analysis scheduler while queue-owned sessions exist.

After resolving a terminal failure, the owner can reset that failed row's state to
`queued`, attempts to zero and next_attempt_at to `now()`. Never reset a processing
row or erase a lease. Archive/clear its old alert explicitly if a fresh notification
is wanted; visitors cannot perform either operation.

## Verified platform constraints (29 September 2026)

[Vercel Hobby Cron](https://vercel.com/docs/cron-jobs/usage-and-pricing) is daily-only
with hourly precision, so it is unsuitable for this queue's dispatch/recovery.
[Supabase Cron](https://supabase.com/docs/guides/cron) and
[Vault-backed HTTP scheduling](https://supabase.com/docs/guides/functions/schedule-functions)
provide recurring delivery. [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net)
starts HTTP requests after transaction commit; recurring sweeps recover missed
delivery. [Vercel function limits](https://vercel.com/docs/functions/limitations)
still apply. The twelve-attempt daily budget is a guardrail, not a guarantee of
free capacity: verify account usage and reduce it if necessary.

## Local verification

`npm test` executes the migration in PostgreSQL via PGlite, including admission,
deduplication, capacity, limits, lease recovery, fenced publication, historical
retries, budget rollover and role grants. Dispatch is executed with deterministic
Vault/network stand-ins to verify lost-delivery recovery and alert acknowledgement.
`python -m pytest tests -q` covers worker authentication, timeout termination and
lease-loss handling alongside the existing analysis/probe tests. Run
`npm run typecheck` and `npm run build` for the dashboard and request endpoint.
