import test from "node:test";
import assert from "node:assert/strict";
import { bestLaps } from "../lib/analysis";
import { lapFlags } from "../lib/advanced";
import { jobTiming, type JobStatus } from "../lib/jobs";
import type { Lap } from "../lib/types";
import { verifyTelemetryReceipts } from "../supabase/functions/_shared/telemetry";

test("OpenF1 quality is conservative while legacy rankings remain unchanged", () => {
  const legacy = { driver: "LEC", number: 2, time: 90, deleted: false, pit_in: null, pit_out: null, accurate: true, track_status: "1", phase: "Q1" } as Lap;
  assert.equal(bestLaps([legacy]).length, 1);
  const uncertain = { ...legacy, time: 89, quality: { issues: ["validity_unverified"], pit_in: false, pit_out: false } };
  assert.equal(bestLaps([legacy, uncertain])[0].time, 90);
  assert.match(lapFlags(uncertain), /Unverified/);
  assert.equal(bestLaps([{ ...uncertain, quality: { issues: [], pit_in: true, pit_out: false } }]).length, 0);
});

test("daily budget determines effective retry time and resets in UTC", () => {
  const job: JobStatus = { state: "queued", attempts: 0, last_attempt_at: null, next_attempt_at: "2026-10-25T12:00:00Z", error_code: null };
  const control = { budget_day: "2026-10-25", daily_attempts: 12, daily_limit: 12 };
  const result = jobTiming(job, control, Date.parse("2026-10-25T15:00:00Z"));
  assert.equal(result.daily_budget_exhausted, true);
  assert.equal(result.effective_retry_at, "2026-10-26T00:00:00.000Z");
  assert.equal(jobTiming(job, control, Date.parse("2026-10-26T01:00:00Z")).daily_budget_exhausted, false);
});

test("immutable publication requires a matching verified receipt for every dependency", () => {
  const chunk = { file: "a".repeat(20) + ".telemetry-0000.json", bytes: 1234, sha256: "b".repeat(64) };
  const manifest = { chunks: [chunk], laps: [{ driver: "LEC", lap: 2, chunk: chunk.file, reason: null }] };
  const receipt = { ...chunk, laps: [{ driver: "LEC", lap: 2 }] };
  assert.equal(verifyTelemetryReceipts(manifest, [receipt]), 1234);
  assert.throws(() => verifyTelemetryReceipts(manifest, []));
  assert.throws(() => verifyTelemetryReceipts(manifest, [{ ...receipt, bytes: 1233 }]));
  assert.throws(() => verifyTelemetryReceipts(manifest, [{ ...receipt, sha256: "c".repeat(64) }]));
  assert.throws(() => verifyTelemetryReceipts(manifest, [{ ...receipt, laps: [{ driver: "ANT", lap: 2 }] }]));
});
