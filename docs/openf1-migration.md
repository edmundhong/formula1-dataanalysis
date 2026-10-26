# OpenF1 ingestion and rollout

The new worker reads free historical OpenF1 endpoints and writes the existing
schema-v1 dashboard artifacts. It needs no OpenF1 account or paid API key. The
calendar-only FastF1 workflow remains in place. Existing published FastF1 sessions
are retained and excluded from OpenF1 claims and correction passes.

## Deployment order

1. Apply `20261025172646_openf1_resumable_ingestion.sql`. This adds private
   checkpoint/upload-receipt tables, a private 48 MiB-per-object checkpoint
   bucket, provider mappings and resumable RPCs. OpenF1 starts **disabled** and
   admission is restricted to `2026-18-Q`.
2. Deploy the `ingest` Edge Function, then the dashboard. The publisher verifies
   immutable telemetry files before recording receipts; final publication checks
   every manifest dependency against those receipts and commits under the active
   lease. The dashboard reads old and new artifacts and shows effective retry
   times including the daily budget.
3. Run `python worker/stage.py` and deploy `.local/production-worker` to the
   existing **separate worker project**. Keep the existing server secrets and
   `F1_WORKER_ENABLED=1`; set `F1_OPENF1_ENABLED=1` on the deployment and production
   project environment while the **database gate remains disabled**. Never upload local
   caches, `.env` files, or runtime credentials as deployment source.
4. Install `supabase/openf1-dispatch.sql` **in place of** the original dispatcher.
   Do not reinstall the original dispatcher after this migration. Verify the
   authenticated worker returns idle while the DB gate is disabled, then enable the DB canary:

   ```sql
   update public.analysis_control set openf1_enabled=true,
     openf1_sessions=array['2026-18-Q'],alerts_enabled=false where id;
   update public.analysis_queue set state='queued',attempts=0,next_attempt_at=now(),
     error_code=null where session_id='2026-18-Q' and state='failed';
   select public.dispatch_analysis();
   ```

   Check `daily_attempts` first. The canary does not raise the twelve-per-day
   limit, reset the shared daily counter, or interrupt a processing lease.
5. Verify `queued → processing → queued` continuations and eventual `succeeded`,
   private checkpoint access, manifest hashes, catalog provider/mapping, the
   original LEC/ANT URL, qualifying phases and arbitrary lap selections. Compare
   retained FastF1 sessions in both themes and on a phone viewport. Run advisors.
6. After canary acceptance, set `openf1_sessions=null` to admit all missing and
   future completed 2026 sessions. Reset other **failed missing** sessions only
   after confirming they are eligible; never reset an active lease. Leave alerts
   disabled. This is not a historical backfill of retained FastF1 results.

## Continuations and capacity

The worker uses one global active lease and the existing 300-second Vercel limit.
Its analysis child yields after roughly 185 seconds, leaving time for the parent
to persist a checkpoint. Every claim counts toward the daily budget; successful
yields do not consume the five-failure allowance. `attempts` therefore represents
failed attempts plus the currently active attempt; `invocations` includes normal
continuations. When the UTC budget is exhausted, work resumes on the next day.

Only the parent holds credentials. Checkpoints are compressed archives of allowed
JSON files, stored under immutable session/lease/hash paths. Restores verify hashes
and reject traversal, links, unexpected files and oversized expanded archives.
Checkpoint commits and releases require the active lease. Upload receipts preserve
publication progress even if the parent crashes immediately after an upload.

The adapter requests no more than one endpoint per 2.1 seconds, uses 20-minute
driver telemetry windows, and persists 429 cooldowns. Empty telemetry results are
explicit gaps; HTTP/network failures do not become silently empty datasets.
Metadata changes invalidate derived traces and staged publication before reuse.
Temporary checkpoint bytes share the existing 750 MiB storage budget. Completed
or orphaned archives are deleted through the Storage API after a ten-minute safety
window; abandoned checkpoints expire after seven days without progress.

## Methodology and compatibility

Canonical IDs and URL parameters are unchanged. Provider IDs live separately in
the catalog and artifact provenance. The frontend continues to fetch immutable
session JSON and lazy per-lap chunks; it never calls OpenF1 directly.

Qualifying phase boundaries come from race-control markers. Deletion/reinstatement
messages are applied in time order and phase bests are reconciled against session
results. Unknown source fields are recorded in optional lap quality metadata.
Missing sectors, phase identity, validity or pit status cannot produce a validated
best lap; unknown track/stint quality excludes clean-pace comparisons. Legacy
artifacts without quality metadata keep their existing behavior.

Telemetry distance is integrated from speed in metres per second. Car channels
and location are aligned by UTC timestamps with no extrapolation. The existing
one-second gap, 0.15-second timing/sector and 98% coverage thresholds remain.
Brake/gear use step interpolation. Position coverage is checked separately from
timing: the map uses the most complete selected outline, while timing gaps leave
individual sections unavailable. Missing geometry does not suppress valid deltas. Numbered
corner annotations are omitted because this source has not established alignment.
Pit tables use `lane_duration` and exclude garage visits over five minutes; they
do not substitute the stationary `stop_duration`.

## Verification and rollback

Run `npm test`, `npm run typecheck`, `npm run build` and
`python -m pytest tests -q`. On Windows, point TEMP/TMP and pytest's `--basetemp`
inside `.local/` if the shell sandbox blocks the system temporary directory.
For the local Turbopack CSS-subprocess failure, `next build --webpack` provides a
verified production-build alternative without changing the production build script.

Read-only full-session acceptance:

```sh
python -m pipeline.openf1_probe --session 2026-18-Q --location Austin \
  --starts-at 2026-10-24T21:00:00Z --folder .local/openf1-austin --slices 6
```

This runner never publishes or reads publisher credentials. Inspect the output's
manifest, best laps, quality warnings and checkpoint size before deployment.

Rollback: set `analysis_control.openf1_enabled=false` and disable the worker's
`F1_OPENF1_ENABLED`. Keep the compatible database, publisher and frontend deployed;
published artifacts remain readable. Do not restore the original claim function
or dispatcher: unauthenticated FastF1 archive access is still unavailable.

## Current implementation verification

Local acceptance imported Austin qualifying with 22 drivers, 280 laps, 247 lap
telemetry entries, four bounded telemetry chunks and an approximately 12.8 MB
compressed checkpoint. The importer yielded and resumed successfully. Source
warnings include unresolved NOR Q3 / BEA Q2 best-time checks and geometry coverage
gaps; these remain explicit and do not lower reliability thresholds.

Additional read-only checks normalized Baku FP2 (457 laps), Singapore race
(1,240 laps, 25 pit-lane records) and Singapore sprint (320 laps). Each session
included all 22 drivers, with two sampled lap telemetry downloads. Practice and
sprint samples passed reliability checks; one race sample retained a coverage
warning. These are sampled telemetry checks, not full-session performance runs.

Local browser checks verified the original LEC/ANT shared URL, Q1 phase switching,
track dominance with reliable Q1 traces, a non-fastest ANT lap loaded through its
immutable telemetry chunk, both themes, narrow-screen overflow, and a retained
Australian FastF1 artifact with its original attribution. Preview screenshots are
kept under ignored `.local/`; no preview fixtures are included in production.

Production rollout completed on 26 October 2026 MYT after the owner explicitly
approved deployment and up to three extra canary runs. Austin published in two
runs, the normal daily limit was restored to twelve, and OpenF1 is enabled for
missing/future sessions. See [production deployment evidence](openf1-deployment-status.md).
