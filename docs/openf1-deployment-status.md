# OpenF1 production rollout — 26 October 2026 MYT

The approved migration and Austin qualifying canary are complete. OpenF1 is now
enabled for missing and future completed 2026 sessions. Existing FastF1 artifacts
remain in place; this rollout did not backfill or replace them.

## Deployed services

- Supabase project: `hmdiksuzmfwormmmpwkm`.
- Migration: `20261025172646_openf1_resumable_ingestion`; the repository migration
  filename matches the recorded production migration version.
- Publisher: `ingest`, version 6, ACTIVE, custom token authentication retained.
- Dashboard: `dpl_2q7nvzW4vopTrNdPXgcteNqs3M9t`, READY. Normal production
  `npm run build` / Turbopack build and TypeScript checks passed on Vercel.
- Worker: `dpl_EpzGVwHrYdntK6fpmGoKqHt2Y7dm`, READY, existing Python 3.12 / iad1 /
  300-second project. `F1_OPENF1_ENABLED=1` is set on both the deployment and the
  production project environment.
- Production endpoints remain `https://edmundhong.com/formula1-dataanalysis`
  and `https://formula1-analysis-worker.vercel.app/api/analysis`.
- Installed `supabase/openf1-dispatch.sql`; the existing named two-minute Cron
  dispatcher remains active.

## Canary evidence

- Authenticated worker preflight returned HTTP 200 / idle with the database
  activation gate disabled.
- Austin `2026-18-Q` mapped to OpenF1 session `11392`, meeting `1297`.
- First run checkpointed 12 of 22 drivers (approximately 3.1 MB) and yielded with
  zero failed attempts consumed. The second run restored that private checkpoint
  and published successfully.
- Published at **26 October 2026, 1:38:49 AM MYT**:
  `analysis/2026/2026-18-Q/96b65a96b77b3820a71e.json`.
- Artifact contains 22 drivers, 280 laps, all qualifying phases, 247 lap telemetry
  entries and four immutable telemetry chunks. Every public chunk was downloaded
  and its size, SHA-256 and lap index verified after publication.
- Live browser verified the original LEC/ANT URL updated automatically, Q1
  selection, reliable track dominance, and lazy loading of ANT lap 2. Screenshot:
  ignored `.local/openf1-live.png`.
- Status is intentionally `partial`: source validity/coverage gaps and missing
  numbered corner metadata remain explicit. No reliability thresholds were relaxed.

## Current controls and compatibility

- `analysis_control.enabled=true`, `openf1_enabled=true`, `openf1_sessions=null`.
- `alerts_enabled=false`; no notifications were configured or sent.
- Normal daily limit is **12**, restored immediately after the canary. Two of the
  three owner-approved extra runs were used. The counter for the 25 October UTC
  budget day is 15, including earlier FastF1 attempts; normal work resumes at the
  UTC reset, **26 October at 8:00 AM MYT**.
- Existing Austin FP1/FP2/FP3 requests were checked against completed,
  non-cancelled OpenF1 sessions and requeued with a fresh source retry count.
  Other historical failed sessions were not reset.
- Australian qualifying retained provider `FastF1` and version
  `ec4bd0432e26ee782e19` throughout rollout.
- Public dashboard jobs API and the existing domain homepage returned HTTP 200;
  an invalid job request returned 400. Anonymous access to the private checkpoint
  bucket was rejected. Anonymous clients have no SELECT grant on checkpoint or
  upload-receipt tables.
- Post-migration performance advisors returned no findings. Security advisors
  returned informational findings only for intentionally private RLS tables with
  no browser policies.
- Total measured analysis/checkpoint storage was approximately 409 MiB, below
  the existing 750 MiB guard. Superseded private checkpoint objects remain eligible
  for the worker's normal cleanup after its ten-minute safety window.

Rollback and maintenance instructions are in [the migration runbook](openf1-migration.md).
