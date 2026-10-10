import assert from "node:assert/strict";
import test from "node:test";
import { sectorGeometry, sectorRankings } from "../lib/sector-map";
import type { Lap, Trace } from "../lib/types";

test("sector rankings use the selected statistic and exclude missing or invalid times", () => {
  const laps = [
    { driver: "AAA", sectors: [20, null, 0] },
    { driver: "AAA", sectors: [40, NaN, -1] },
    { driver: "BBB", sectors: [25, 30, 35] },
    { driver: "CCC", sectors: [1, 1, 1] },
  ] as Lap[];
  assert.deepEqual(sectorRankings(laps, ["AAA", "BBB"], "median"), [
    [{ driver: "BBB", seconds: 25 }, { driver: "AAA", seconds: 30 }],
    [{ driver: "BBB", seconds: 30 }], [{ driver: "BBB", seconds: 35 }],
  ]);
  assert.equal(sectorRankings(laps, ["AAA", "BBB"], "fastest")[0][0].driver, "AAA");
});

test("sector timing lines interpolate matching lap telemetry and share exact endpoints", () => {
  const trace = { driver: "AAA", lap: 2, reliable: true, time: [0, 10, 20, 30, 40], x: [0, 100, 200, 100, 0], y: [0, 0, 100, 200, 0] } as Trace;
  const laps = [{ driver: "AAA", number: 1, sectors: [1, 1, 38] }, { driver: "AAA", number: 2, sectors: [15, 10, 15] }] as Lap[];
  const sectors = sectorGeometry({ traces: [trace], laps })!;
  assert.deepEqual(sectors[0].at(-1), { time: 15, x: 150, y: 50 });
  assert.deepEqual(sectors[0].at(-1), sectors[1][0]);
  assert.deepEqual(sectors[1].at(-1), { time: 25, x: 150, y: 150 });
  assert.deepEqual(sectors[1].at(-1), sectors[2][0]);
  assert.equal(sectorGeometry({ traces: [{ ...trace, reliable: false }], laps }), null);
  assert.equal(sectorGeometry({ traces: [{ ...trace, x: [0, null, 200, 100, 0] }], laps }), null);
  assert.equal(sectorGeometry({ traces: [trace], laps: [] }), null);
});
