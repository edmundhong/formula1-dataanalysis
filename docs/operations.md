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

The workflow runs on the default branch hourly at minute 17. It refreshes the race calendar daily and processes at most three eligible sessions per run, newest first. Preseason testing and seasons before 2026 are excluded. Later seasons are added as the calendar year advances.

Scheduled start times are UTC. To avoid ingesting incomplete events, attempts start conservatively after three hours for races, 90 minutes for sprints/sprint qualifying, and two hours for other sessions. The processor also requires a final FastF1 session status (`Finished`, `Finalised`, or `Ends`). Red-flag delays can postpone ingestion.

Unpublished recent sessions retry hourly for 48 hours, then daily through day seven. Unattempted older sessions are eligible for backfill. Published sessions receive correction passes after 24 hours and seven days relative to the estimated session end. Correction passes bypass FastF1 caches. Sessions needing later manual recovery can be forced explicitly.

GitHub schedules can be delayed or dropped, and public-repository scheduled workflows can be disabled after 60 days without repository activity. Check the Actions page if the catalogue stops updating; re-enable the workflow when needed. Supabase free projects may pause during inactivity; restore the project from its dashboard before rerunning ingestion. No paid upgrade is enabled automatically.

Manual recovery/backfill from GitHub CLI:

```sh
gh workflow run ingest.yml -f limit=10
gh workflow run ingest.yml -f session=2026-01-Q -f force=true
```

For local processing, set `F1_INGEST_URL` and `F1_INGEST_TOKEN` in the shell, then run `python -m pipeline.ingest --limit 3`. Use `--local --session 2026-01-Q` to generate an ignored `.local` artifact without publishing. A failed session does not overwrite the previous successful file. Expected provider unavailability produces a failed workflow so the owner can inspect it in GitHub.

Deployment verification on 27 September 2026 found that GitHub-hosted runners received HTTP 403 from the F1 timing source; the FastF1 mirror returned HTTP 404 for the same session. Both Linux and macOS runners failed, while local processing succeeded. The hourly workflow remains enabled, but unattended cloud ingestion is not yet verified. Until upstream access is restored, run the publisher locally with the existing credentials and force an individual failed historical session as shown above. Published files remain available during failed updates. Do not assume the remaining season backfill is progressing when these source errors recur.

## Publication, storage and security

Session metadata and publication pointers live in `sessions`. Internal attempt history lives in `ingestion_jobs` and `ingestion_state`; anonymous clients cannot read them. All three tables have RLS enabled. Internal tables intentionally have no client policies. Published F1 analysis files are public; bucket writes are restricted to the server-side publisher.

Files use content-derived version names. Upload completes before the catalogue pointer changes. Repeating a publication is idempotent, and malformed uploads leave the last successful pointer intact. Old artifacts are removed after seven days while retaining the current and previous versions. A new upload is refused above the app's conservative 750 MiB storage budget; existing data remains available. Watch database size and monthly bandwidth in Supabase as traffic and seasons increase.

Raw FastF1 caches stay in the GitHub runner cache, bounded to approximately 1 GB. They are never committed or copied to Supabase. Frontend payloads retain 1,000 samples only for each driver's fastest valid lap and qualifying segment. Browser catalogue refresh runs every five minutes while visible; immutable analysis files use long cache lifetimes.

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
