# Advanced selection

Both views start with a collapsed Advanced selection panel. Opening it does not change the analysis. Explicitly choosing comparison laps or independent pace selections activates the corresponding controls; collapsing the panel retains them. Reset returns that view to its shared/default selection. The URL contains both views' advanced selections, including the delta reference and lap exclusions. Changing sessions resets session-specific selections.

## Lap comparisons

Choose up to four driver/segment/lap slots within one session. Multiple slots may use the same driver. Fastest in segment uses a positive, accurate, non-deleted, green-flag lap without a pit entry/exit. Explicit lap selection uses the chosen recorded lap, including flagged laps when enabled. Qualifying and sprint qualifying use Q1–Q3 and SQ1–SQ3 labels respectively; the stored phase identifiers remain Q1–Q3 for compatibility.

Selected lap sectors are actual recorded sectors. Session rankings, theoretical best sectors and team speed summaries remain separate summaries. Telemetry and dominance identify comparison slots independently, even for the same driver. A missing reference never falls back to another lap. Delta and dominance require reliable timing; speed/channel charts can still show available telemetry with an unreliable-timing label.

## Pace selections

Activate independent selection to copy shared filters into each selected driver's compound, stint, clean-lap setting and lap range. Each driver has an explicit exclusion list. Checking a lap removes the manual exclusion, but does not override the other filters. Counts, lap-time charts, distributions, median sectors and tyre-age trends all use the same included laps. Full-session strategy, position and pit-lane panels retain full-session labels. Compare this lap opens Best Lap and appends that lap to the comparison, replacing the fourth slot when all slots are occupied.

Long-run classification and degradation estimates are deferred. Existing tyre-age plots show observations without correcting for fuel, traffic, weather or track evolution.

Race and Sprint include a Gap to leader chart using full-session finish-line timing, independent of pace filters and exclusions. Session leader (default) uses the earliest finish timestamp for each lap across the field; Leader of selection uses only selected drivers. The reference can change each lap. Gaps compare equal completed distance, retain pit-stop losses and lapped drivers’ full time deficits, and leave breaks for missing timing. The reference resets when sessions change. Optional lap `end_time` records FastF1 `Time` in session-relative seconds; schema version 1 remains compatible. Older publications without these timestamps show an unavailable message until refreshed through the existing queue. Deploy the worker and dashboard before refreshing Race/Sprint publications; validate a locally regenerated artifact first.

## Telemetry files and publication

The version-1 artifact adds an optional `telemetry_manifest` with `chunks` (file, UTF-8 byte size, SHA-256 digest) and one `laps` entry per recorded lap (driver, lap number, chunk or unavailable reason). Existing embedded fastest-lap traces remain supported. Extra JSON files use `<version>.telemetry-NNNN.json` alongside the main artifact and stay below 4 MiB. A chunk contains `schema_version`, `session_id` and resampled `traces`.

Workers prepare all laps with positive timing when source telemetry is available. Missing timing/coverage remains explicit. They merge car/position channels without calculating the unused DriverAhead channel, and retain the existing 1,000-sample resampling, gap and reliability checks. Files are written incrementally to bound memory. Browsers load only files required by selected laps and verify byte size, digest, session identity and sample arrays. Requests are aborted on selection/session changes; stale responses cannot replace the current comparison.

The protected ingest endpoint accepts `action: telemetry` with session/version/file/digest and `chunk_json` containing the exact source bytes as text. This preserves Python numeric serialization for digest verification. Existing publisher authentication and worker lease checks apply to uploads. The final `publish` request verifies all indexed dependencies before the existing atomic, lease-checked pointer commit. Storage accounting includes the main artifact plus chunks; the global 750 MiB budget and 12 MiB request limit remain enforced. Cleanup retains current/previous version files and removes older files after seven days on successful publication, including orphan chunks from interrupted publications.

## Verification and rollout

No database migration or broader client permissions are required. Deploy the ingest function before the updated worker, and then deploy the dashboard. Stage the worker with the existing staging command; its allowlist now includes `telemetry.py`. The child retains its 210-second limit; publication shares a 285-second overall deadline, leaving time to record a safe failure before Vercel's 300-second limit.

Locally reprocess representative sessions without publishing:

```sh
python -m pipeline.benchmark_advanced 2026-15-FP2 2026-01-Q 2026-01-R --offline
```

Omit `--offline` when the source is not already cached. Artifacts, telemetry and measured metrics are written under `.local/advanced-benchmark`. Cached measurements on the development machine: FP2 456 laps / 21.38 s / 21.68 MB extra telemetry; qualifying 353 laps / 14.30 s / 14.80 MB; race 1,006 laps / 54.19 s / 58.17 MB. These are cached local measurements, not cold Vercel timing or network-publication measurements. Source data accounts for unavailable laps, which remain individually labelled. Every measured file was below 4 MiB; main artifacts remained below 12 MiB.

After deployment, refresh those same three sessions through the existing bounded queue and verify live processing time, file downloads, storage accounting and UI comparisons before historical backfill. An administrator can requeue published sessions without changing queue controls:

```sql
begin;
select pg_advisory_xact_lock(26092901);
insert into public.analysis_queue(session_id, state, next_attempt_at)
select id, 'queued', now() from public.sessions
where id in ('2026-15-FP2', '2026-01-Q', '2026-01-R')
  and artifact_path is not null and status <> 'cancelled'
  and (select count(*) from public.analysis_queue
       where state in ('queued','retry','processing')) <= 17
on conflict (session_id) do update
set state='queued', attempts=0, next_attempt_at=now(),
    lease_token=null, lease_expires_at=null, error_code=null
where analysis_queue.state in ('succeeded','failed');
commit;
```

For older cached sessions without a manifest, queue at most three at a time, oldest first. Wait for completion and confirm remaining storage before the next batch. Preserve daily attempts, concurrency and admission limits. Full-season telemetry may exceed the existing budget; stop backfill when there is insufficient space. Old artifacts continue to support timing, sectors and their embedded fastest-lap telemetry until refreshed. Rollback the dashboard/worker if needed; the previous artifacts remain downloadable.

## Circuit corner numbers

New analysis artifacts include optional `corners` metadata from FastF1: `number`, `letter`, `x`, `y`, and `angle`. The map keeps its existing orientation and projects both telemetry and markers through the same transform. Badges use the source angle, stay inside the SVG bounds, and move apart when nearby corners would overlap. Their overlay does not intercept section hover or focus interactions. Older artifacts and missing source metadata continue to display the map without badges.

Deploy the updated dashboard and Python worker before requeueing existing publications. Use the bounded queue procedure above, first validating Australia qualifying (`2026-01-Q`) and Azerbaijan practice (`2026-15-FP2`) for compact and crowded layouts. Confirm the newly published artifact contains nonempty `corners`, map alignment and mobile readability, and storage headroom before continuing with batches of at most three published sessions. Do not use the legacy publisher to bypass queue limits. A source failure produces an empty corner list without failing the session analysis; inspect worker warnings before retrying those sessions.
