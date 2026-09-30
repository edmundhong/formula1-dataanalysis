# FastF1 Vercel experiment

This is an opt-in experiment, not a production API. Nothing is added to the
dashboard's routes, Vercel configuration, scheduled workflow or publisher.
Results: [feasibility report](../../docs/vercel-probe-report.md).

## Reproduce

1. Use the existing Python 3.12 environment with `pipeline/requirements.txt`.
   Run `python -m pytest tests -q`.
2. Read the current Vercel project plan and resource settings. The experiment
   is configured for the verified Hobby Fluid limits: 300 seconds, 2,048 MiB,
   `iad1`. Reassess these constants before running on a different plan.
3. Run `python experiments/vercel_probe/stage.py`. It creates an allowlisted
   deployment under `.local/vercel-probe`, copies the current pipeline, pins
   its runtime dependencies and links to the existing Vercel project.
   Deploy that directory explicitly with `--target preview`, never `--prod`.
4. Supply runtime-only variables through the authenticated CLI: `F1_PROBE_ENABLED=1`,
   `F1_PROBE_TOKEN` (a random token of at least 32 characters), and
   `F1_PROBE_EXPIRES_AT` (Unix seconds, normally 30 minutes ahead).
   Do not place secrets in source, shell history literals or reports.
5. POST `/api/ingestion-probe` on the isolated deployment with
   `Authorization: Bearer <owner token>` and JSON
   `{"session_id":"2026-12-R","mode":"source"}`. Test `2026-01-Q` too.
   Vercel Deployment Protection is separate from the endpoint's owner check;
   `vercel curl` can handle that protection using the logged-in owner account.
6. Only if source checks pass, use `mode: "full"` twice per session. Each request
   starts a new subprocess and temporary cache, kills it at 270 seconds, and
   removes the cache afterward. Responses contain summaries, never raw telemetry.
   Pass limits are 225 seconds, 1,536 MiB combined parent/worker peak RSS, and
   a maximum 12 MiB serialized artifact. Infrastructure OOM/termination can
   still prevent a JSON response; treat non-JSON/5xx responses as failed probes.
7. Compare `rankings`, `telemetry_drivers`, and lap/driver/trace counts with a
   fresh local `python -m pipeline.probe SESSION full EMPTY_DIRECTORY` run.
   The local worker needs an existing empty directory and retains its cache.

## Isolated publication, only after the processing gate passes

Apply `setup.sql` as a disposable experiment, not a production migration.
Run `stage_publisher.py` and deploy **only** `ingest-probe-20260928` from
`.local/probe-publisher` with the existing Supabase project and worker-token
authentication. This copies the existing publisher implementation, substitutes
the test catalog/job/state tables and bucket, and adds a 30-minute expiry.
The existing storage-budget check remains conservative against production usage.
Never deploy this copy under the production function name `ingest`.

Redeploy the preview with `F1_PROBE_PUBLISH_URL` set to the exact isolated
function URL enforced in `pipeline/probe.py`, and `F1_PROBE_PUBLISH_TOKEN` set
server-side to the existing worker credential. Run qualifying in full mode.
Publication errors have their own `publication_failure` category.
Download the test artifact anonymously, reject an invalid schema upload, and
confirm the production rows are unchanged. `stage_dashboard.py` makes a local
dashboard copy reading only the isolated catalog and bucket; use it to check
the actual charts and rankings without changing the production frontend.

## Cleanup

Save credential-free summaries, then remove the exact experiment deployment IDs
with `vercel remove`. Delete the test object and bucket using the Supabase
Storage API/CLI, delete only `ingest-probe-20260928`, and drop the three
`probe20260928_*` tables. Close the local dashboard and remove the generated
owner token. Do not delete production resources. The endpoint additionally
fails closed without its enable flag, outside preview, or after expiry.
