# Operations and methodology

## Deployment

- Vercel project: `formula1-dataanalysis`; Next.js base path: `/formula1-dataanalysis`.
- Supabase project: `formula1-dataanalysis`, Singapore, free plan, organization `edmundhong`.
- Browser configuration: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in Vercel production, preview and development environments.
- GitHub Actions secrets: `F1_INGEST_URL` (the Supabase `ingest` function URL), `F1_INGEST_TOKEN` (random 32-byte token represented as hex).
- Supabase function secret: `F1_INGEST_TOKEN_HASH` (hex SHA-256 of the token). Keep the raw token out of source control. The function's JWT check is disabled because it implements its own worker authentication before parsing requests.
- Apply the versioned SQL migrations, set the function secret, and deploy `supabase/functions/ingest` using the Supabase CLI. Do not expose a service-role key to browsers or GitHub Actions.
- The domain routing repository is `edmundhong/edmundhong`. Add rewrites for `/formula1-dataanalysis` and `/formula1-dataanalysis/:path*` to the verified app's Vercel origin, preserving the path. Do not rewrite to `edmundhong.com` itself.

## Automatic ingestion

The GitHub workflow runs hourly at minute 17 and refreshes the calendar daily.
Analysis now uses the durable Supabase queue and bounded Vercel worker described
in [queue operations](queue-operations.md). Follow that deployment order before
enabling dispatch; the default allowlist contains only the two probe sessions.

Sessions are attempted after three hours for races, 90 minutes for sprints/sprint
qualifying, and two hours for other sessions. FastF1 must also confirm a final
session status. Historical failures retry with bounded backoff regardless of age.
Published sessions retain correction passes after 24 hours and seven days.

Use `gh workflow run ingest.yml -f force=true` to refresh the calendar. For analysis
recovery, inspect and reset a terminal queue row as described in the queue runbook.
For an offline local artifact, use `python -m pipeline.ingest --local --session 2026-01-Q`.
Legacy local publication is rejected for sessions owned by the queue.

GitHub-hosted timing-source refusal was reproduced in September 2026; the Vercel
probe succeeded for two sessions in iad1. This supports the bounded rollout, not
guaranteed upstream access or season-wide coverage. Supabase free projects may
pause during inactivity; restore them before expecting queue progress.
## Publication, storage and security

Session metadata and publication pointers live in `sessions`. Internal attempt history lives in `ingestion_jobs` and `ingestion_state`; anonymous clients cannot read them. All three tables have RLS enabled. Internal tables intentionally have no client policies. Published F1 analysis files are public; bucket writes are restricted to the server-side publisher.

Files use content-derived version names. Upload completes before the catalogue pointer changes. Repeating a publication is idempotent, and malformed uploads leave the last successful pointer intact. Old artifacts are removed after seven days while retaining the current and previous versions. A new upload is refused above the app's conservative 750 MiB storage budget; existing data remains available. Watch database size and monthly bandwidth in Supabase as traffic and seasons increase.

Raw FastF1 analysis caches live in a fresh temporary directory for each Vercel worker and are removed when it finishes. They are never committed or copied to Supabase. Frontend payloads retain 1,000 samples only for each driver's fastest valid lap and qualifying segment. Browser catalogue refresh runs every five minutes while visible; immutable analysis files use long cache lifetimes.

## Analysis definitions

- **Fastest lap:** lowest positive complete lap time with no deleted flag or pit entry/exit. Missing lap time is reconstructed only when all three sector times exist. Qualifying segments use FastF1's segment boundaries. These rankings compare best laps, not necessarily official starting-grid order.
- **Clean pace:** positive, non-deleted, accurate, green-flag (`TrackStatus == '1'`) laps, excluding lap one and pit-in/out laps. Remove laps above 107% of the median of eligible laps in the same driver/stint group. All timed laps disables those exclusions. Wet laps can remain eligible; filter compounds and compare like-for-like stints.
- **Pit-lane time:** matched entry/exit events ordered separately for each driver. Unpaired events and garage visits over five minutes are excluded. This is not stationary service time.
- **Track dominance:** elapsed telemetry time resampled onto 1,000 normalized lap-distance points, with the first selected driver's geometry as reference. Compare traversal time across 50 sections. Same-team colours remain unchanged; patterns, labels, and line styles distinguish drivers. Differences below 0.01 seconds count as approximate ties.
- **Quality controls:** no extrapolation, no interpolation across telemetry gaps over one second, positive monotonic distance/time, lap-end/start timing within 0.15 seconds and sector totals within 0.15 seconds of lap time. Reject timing comparisons below 98% coverage. Missing sections cannot produce a winner. Normalized distance does not resolve racing-line differences, so dominance and delta remain estimates rather than official mini-sector timing.
- **Tyre-age trends:** separated by driver, stint and compound. No claimed fuel, traffic, weather or track-evolution correction.

Data can arrive partially. Missing telemetry must not disable lap tables, pace charts or other available measurements. Source colours are taken from `fastf1.plotting.get_driver_color(..., colormap='official')`, falling back to the session's supplied `TeamColor`.

## Validation

Python fixtures cover rankings, lap exclusions, pit matching, telemetry interpolation, sprint calendars, cancellation safeguards and retry scheduling. TypeScript fixtures cover client ranking/filtering, section-time dominance, immutable publication identity and calendar reconciliation. Before deploying, run both test suites, type checking and a production build. Verify real qualifying/race data, both themes, a phone viewport, shared URLs, anonymous write rejection and all existing domain routes.
