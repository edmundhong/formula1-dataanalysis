# Austin race publication fix — 26 October 2026

The race import for `2026-18-R` initially stopped at the daily run budget. The
production allowance was increased to 50 worker claims per UTC day at the owner's
request. A subsequent `publication_failed` error was independent of that budget.

Local reproduction from the saved 18-driver production checkpoint completed all
22 drivers, then failed in `checkpoints.pack()` with `Checkpoint exceeds limit`.
The final archive included both intermediate driver traces and immutable output
chunks, duplicating telemetry and exceeding the existing 48 MiB compressed cap.

Completed checkpoints now omit intermediate driver/window/unversioned telemetry
files once `artifact.json` exists. They retain the immutable chunks, artifact,
metadata, source-validation state, and upload receipts. Partial checkpoints still
retain download progress. Source changes invalidate the staged output and trigger
fresh downloads as before. Packing does not delete live working files.

The real race checkpoint now compresses to 25,937,673 bytes (24.7 MiB) and restores
successfully. All 20 OpenF1 and worker tests pass, including completed-checkpoint
resume and late source-change invalidation. Storage and checkpoint limits remain
unchanged; daily processing is still capped at 50 claims.

Production verification: worker deployment `dpl_58eAXD1Z6Kktsj8MpJYNCQNcb9fa`
is READY and aliased to the existing worker endpoint. The resumed race reached
`succeeded` with 17 verified uploaded chunks and catalogue artifact
`2026/2026-18-R/aa5064781f9f97cf4b14.json`. The production completed checkpoint was
25,938,029 bytes. The fix required no database schema or publisher changes.
