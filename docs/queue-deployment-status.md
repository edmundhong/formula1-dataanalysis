# Queue rollout status — 29 September 2026

Queue processing is active. The owner explicitly requested no notifications; `analysis_control.alerts_enabled=false`. No webhook is required for processing and no alert tests were sent.

## Production

- Supabase project: `hmdiksuzmfwormmmpwkm`.
- Applied `durable_analysis_queue` and `queue_dispatch_optional_alerts` migrations.
- Ingest Edge Function version 3 is active with custom token authentication.
- Worker: https://formula1-analysis-worker.vercel.app/api/analysis
- Worker deployment: `dpl_A34zQUR1iaTEbu48rFjpHK85fJzs`; Python 3.12, Fluid Compute, iad1, 300 seconds, standard 2 GiB memory; `F1_WORKER_ENABLED=1`.
- Dashboard: https://edmundhong.com/formula1-dataanalysis
- Dashboard deployment: `dpl_CqPHpQRfG4yeDCftaSzZQ2DdAthF`; `F1_QUEUE_ENABLED=1`.
- Vault contains the worker URL and token. No owner alert webhook was configured.
- Database processing is enabled, restricted to `2026-01-Q` and `2026-12-R`, with twelve attempts per database day.
- Cron `f1-analysis-dispatch` is active every two minutes.
- The legacy GitHub ingestion workflow was disabled to prevent competing analysis. Calendar-only source changes are local and still need publication before calendar refresh can resume. Do not re-enable the legacy version.

## Verification

- All nine JavaScript tests and 21 Python tests passed. Tests cover processing without a webhook and no notification delivery while alerts are disabled, even when a webhook exists.
- Both production builds reached READY.
- Authenticated worker preflight returned HTTP 200, idle, before database activation.
- Live Cron dispatch admitted `2026-12-R`, which progressed through processing to succeeded on attempt one.
- The public dashboard job API reports enabled=true and succeeded.
- Published artifact returned HTTP 200 at `analysis/2026/2026-12-R/244ba81c00e54cee0c16.json`. Catalog status is partial, not complete.
- `2026-01-Q` retained its existing artifact; no forced rerun was requested.
- Security advisors returned informational findings for intentionally private RLS tables only.

## Remaining validation

Full live fault-injection/recovery checks and both-pilot revalidation have not been completed. Keep the two-session allowlist until those checks and usage review are complete. Alerts must remain disabled until the owner explicitly requests them.
