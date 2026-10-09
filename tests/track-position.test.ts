import assert from "node:assert/strict";
import test from "node:test";
import { trackPosition } from "../lib/track-position";

const geometry = { x: [0, 100, 100], y: [0, 0, 100] };

test("uses the chart reference distance to interpolate the map geometry", () => {
  assert.deepEqual(trackPosition(geometry, [0, 200, 500], 350), { x: 100, y: 50, index: 1.5 });
  assert.deepEqual(trackPosition(geometry, [0, 200, 500], 0), { x: 0, y: 0, index: 0 });
  assert.deepEqual(trackPosition(geometry, [0, 200, 500], 500), { x: 100, y: 100, index: 2 });
});

test("hides the marker outside the lap, on leave, or across missing coordinates", () => {
  for (const distance of [null, NaN, -1, 501]) {
    assert.equal(trackPosition(geometry, [0, 200, 500], distance), null);
  }
  assert.equal(trackPosition({ x: [0, null], y: [0, 100] }, [0, 200], 100), null);
  assert.equal(trackPosition(geometry, [], 100), null);
});
