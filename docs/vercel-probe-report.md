# FastF1 on Vercel: feasibility passed

Tested 28 September 2026 on the existing Vercel Hobby project with Fluid Compute,
Python 3.12, FastF1 3.8.3 and region `iad1`. The production website, workflow and
session pointers were not changed. No provider migration or paid upgrade was made.

## Measurements

All runs used a new subprocess and empty FastF1 cache. Memory is the conservative
sum of child peak RSS and parent peak RSS, not a measurement of concurrency or
all platform overhead. Limits were 300 seconds and 2,048 MiB; acceptance required
at least 25% headroom. Artifact sizes below use Python serialization; the publisher
reserializes JSON and produces a slightly smaller stored file.

| Session | Run | Elapsed | Combined peak memory | Artifact bytes | Result |
| --- | --- | --- | --- | --- | --- |
| Dutch race, 2026-12-R | 1 | 40.296 s | 649.4 MiB | 1,585,682 | Pass |
| Dutch race, 2026-12-R | 2 | 36.718 s | 650.6 MiB | 1,585,682 | Pass |
| Australian qualifying, 2026-01-Q | 1 | 34.970 s | 404.6 MiB | 3,969,231 | Pass |
| Australian qualifying, 2026-01-Q | 2 | 31.922 s | 406.2 MiB | 3,969,231 | Pass |

The main timing source returned 200 for session info, session status and timing
streams in both environments. The mirror returned 404. Unlike the previously
observed GitHub runner, this Vercel region could reach the main source.

All four outputs matched fresh local runs on lap rankings, telemetry drivers,
trace count, lap count and driver count. Dutch race: 1,368 laps, 22 drivers,
20 traces, with the same partial-telemetry notice locally and remotely.
Qualifying: 353 laps, 22 drivers and 63 traces, with no unavailable-data notice.

An initial preview packaging issue (`ModuleNotFoundError` in the subprocess)
was corrected by forwarding the runtime's Python import path. Subsequent source
and full-analysis checks passed.

## Publication and verification

A fifth fresh qualifying run completed analysis and isolated publication in
40.400 seconds, with approximately 405.5 MiB combined peak RSS. The copied,
authenticated publisher wrote 3,601,469 bytes to the test bucket. Version
`9bb3cf3b3d6bc602519e` matched the previously successful qualifying publication.
Only the disposable test catalog received the new pointer.

- Anonymous artifact download: HTTP 200, schema 1, expected session and counts.
- Malformed artifact/schema: HTTP 400; successful pointer retained.
- Missing probe owner token: HTTP 401.
- Anonymous catalog write: HTTP 401.
- Actual dashboard copy: displayed Available, Russell 1:18.518, Antonelli +0.293,
  rankings, circuit dominance, telemetry, sectors and weather from test storage.
- Runtime log scan found neither the owner token nor publisher credential.
- Python suite: 17 passing tests, including authentication, expiry, input
  validation, source fallback classification and terminating an overlong worker.
- Production qualifying version/timestamp and unpublished Dutch race pointer
  were unchanged before and after the experiment.

Measurements are saved in [vercel-probe-results.json](vercel-probe-results.json).
The three preview deployments, temporary publisher, test object/bucket and test
tables were removed after verification. The diagnostic API is no longer live.
The local owner token was deleted and the CLI-created preview-access token was
revoked. The removed preview URL returns HTTP 404.

## Recommended production follow-up

Keep FastF1. These results support a bounded Vercel worker, not long synchronous
browser requests. They demonstrate feasibility for two sessions, not guaranteed
future upstream access, every session size, concurrency, or free-tier capacity.

1. Add a durable Supabase queue keyed by session, with atomic claims, expiring
   leases, heartbeat, deduplication and recovery after worker termination.
2. Let anonymous visitors enqueue missing completed sessions through a server
   endpoint with per-client limits, per-session cooldowns and a global queue cap.
   Return job status immediately; do not expose worker credentials or accept
   arbitrary URLs. Keep worker concurrency at one initially.
3. Use a supported durable dispatch mechanism to invoke bounded Vercel workers
   and recover missed dispatches. Confirm Hobby scheduling and usage constraints
   before selecting that mechanism; do not rely on unawaited background promises.
4. Preserve immutable publication and the previous successful artifact. Retry
   historical failures beyond seven days using bounded backoff and fair scheduling.
5. Expose safe queued/processing/retry/failed states and last-attempt information
   to the dashboard; poll active jobs without implying every pending session is
   automatically progressing. Alert the owner on persistent source refusal or
   resource failures. Roll out with the two tested sessions before season backfill.

OpenF1 remains a fallback evaluation if access or coverage later deteriorates;
this experiment provides no reason to migrate now.
