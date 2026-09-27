import { test } from "node:test";
import assert from "node:assert/strict";
import { bestLaps, dominance, formatTime, paceLaps } from "../lib/analysis";
import type { Lap, Trace } from "../lib/types";
const lap = (
  driver: string,
  time: number | null,
  extra: Partial<Lap> = {},
): Lap => ({
  driver,
  time,
  number: 2,
  sectors: [30, 30, 30],
  stint: 1,
  compound: "SOFT",
  tyre_age: 2,
  fresh: true,
  position: 1,
  deleted: false,
  accurate: true,
  track_status: "1",
  pit_in: null,
  pit_out: null,
  phase: "Q1",
  clean: true,
  ...extra,
});
const trace = (driver: string, seconds: number): Trace => ({
  driver,
  phase: "ALL",
  lap: 1,
  lap_time: seconds,
  distance: Array.from({ length: 1000 }, (_, i) => i * 5),
  time: Array.from({ length: 1000 }, (_, i) => (i / 999) * seconds),
  speed: [],
  throttle: [],
  brake: [],
  gear: [],
  rpm: [],
  x: [],
  y: [],
  reliable: true,
  reason: null,
});
test("ranking sorts values, rejects deleted/missing times, and scopes segments", () => {
  const laps = [
    lap("AAA", 95),
    lap("BBB", 91),
    lap("CCC", null),
    lap("AAA", 80, { deleted: true }),
    lap("BBB", 90, { phase: "Q3" }),
  ];
  assert.deepEqual(
    bestLaps(laps).map((l) => l.time),
    [90, 95],
  );
  assert.equal(bestLaps(laps, "Q1")[0].time, 91);
  assert.equal(formatTime(125.045), "2:05.045");
});
test("pace filters and all timed laps", () => {
  const laps = [
    lap("AAA", 90),
    lap("AAA", 120, { clean: false }),
    lap("BBB", 91),
  ];
  const filter = {
    drivers: ["AAA"],
    compound: "ALL",
    stint: "ALL",
    from: 1,
    to: 5,
    clean: true,
  };
  assert.equal(paceLaps(laps, filter).length, 1);
  assert.equal(paceLaps(laps, { ...filter, clean: false }).length, 2);
  assert.equal(paceLaps(laps, { ...filter, compound: "WET" }).length, 0);
});
test("dominance measures traversal time and preserves ties", () => {
  const a = trace("AAA", 90),
    b = trace("BBB", 92);
  const sections = dominance([a, b]);
  assert.equal(sections.length, 50);
  assert.ok(sections.every((s) => s.winner === "AAA"));
  assert.equal(
    dominance([a, trace("BBB", 90.1)]).filter((s) => s.tied).length,
    50,
  );
});
test("missing sections and unreliable telemetry cannot create winners", () => {
  const a = trace("AAA", 90),
    b = trace("BBB", 92);
  b.time[10] = null;
  assert.equal(dominance([a, b])[0].winner, null);
  b.reliable = false;
  assert.equal(dominance([a, b]).length, 0);
  assert.equal(dominance([a]).length, 0);
});
