import { test } from "node:test";
import assert from "node:assert/strict";
import { raceGaps } from "../lib/race-gap";
import { paceLaps } from "../lib/analysis";
import type { Lap } from "../lib/types";

const lap = (driver: string, number: number, end_time?: number | null, extra: Partial<Lap> = {}): Lap => ({
  driver, number, end_time, time: 90, sectors: [], stint: 1, compound: "SOFT",
  tyre_age: number, fresh: true, position: null, deleted: false, accurate: true,
  track_status: "1", pit_in: null, pit_out: null, phase: "ALL", clean: true, ...extra,
});

test("race gaps use changing leaders at equal completed distance and sort unsorted laps", () => {
  const input = [lap("BBB", 2, 190), lap("AAA", 1, 100), lap("BBB", 1, 105), lap("AAA", 2, 195)];
  assert.deepEqual(raceGaps(input, ["AAA"])[0].points, [
    { lap: 1, gap: 0, reference: "AAA" }, { lap: 2, gap: 5, reference: "BBB" },
  ]);
  assert.deepEqual(raceGaps(input, ["AAA"], "selection")[0].points.map((p) => p.gap), [0, 0]);
  assert.deepEqual(raceGaps(input, ["AAA", "BBB"], "selection"), raceGaps(input, ["AAA", "BBB"]));
  assert.equal(input[0].driver, "BBB");
});

test("selection leader excludes an unselected overall leader and resolves ties deterministically", () => {
  const input = [lap("CCC", 1, 100), lap("BBB", 1, 110), lap("AAA", 1, 110)];
  assert.equal(raceGaps(input, ["BBB", "AAA"])[0].points[0].gap, 10);
  assert.deepEqual(raceGaps(input, ["BBB", "AAA"], "selection")[0].points[0],
    { lap: 1, gap: 0, reference: "AAA" });
});

test("missing timestamps and absent laps break lines; retired drivers stop at their final lap", () => {
  const input = [lap("AAA", 1, 100), lap("AAA", 2, 200), lap("AAA", 3, 300), lap("AAA", 4, 400),
    lap("BBB", 1, 105), lap("BBB", 3, null), lap("CCC", 1, NaN), lap("CCC", 2, Infinity)];
  assert.deepEqual(raceGaps(input, ["BBB"])[0].points.map((p) => p.gap), [5, null, null]);
  assert.deepEqual(raceGaps(input, ["CCC"])[0].points.map((p) => p.gap), [null, null]);
  assert.deepEqual(raceGaps(input, ["NONE"])[0].points, []);
  assert.deepEqual(raceGaps(input, []), []);
});

test("full timing retains pit losses, disrupted laps and deficits longer than a lap", () => {
  const input = [lap("AAA", 1, 100), lap("BBB", 1, 105), lap("AAA", 2, 190),
    lap("BBB", 2, 330, { time: null, clean: false, pit_in: 200, track_status: "4", deleted: true })];
  const before = raceGaps(input, ["BBB"]);
  const filtered = paceLaps(input, { drivers: ["BBB"], clean: true, compound: "HARD", stint: "ALL", from: 2, to: 2 });
  assert.equal(filtered.length, 0);
  assert.deepEqual(raceGaps(input, ["BBB"]), before);
  assert.deepEqual(before[0].points.map((p) => p.gap), [5, 140]);
});

test("older artifacts have unavailable gaps without a cumulative lap-time fallback", () => {
  const input = [lap("AAA", 1), lap("BBB", 1, null)];
  assert.ok(raceGaps(input, ["AAA", "BBB"]).every((s) => s.points.every((p) => p.gap === null)));
});
