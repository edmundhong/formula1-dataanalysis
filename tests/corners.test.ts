import assert from "node:assert/strict";
import test from "node:test";
import { cornerMarkers } from "../lib/corners";

test("older artifacts and invalid corners produce no badges", () => {
  assert.deepEqual(cornerMarkers(undefined, v => v, v => v), []);
  assert.deepEqual(cornerMarkers([{ number: 1, letter: "", x: NaN, y: 0, angle: 0 }], v => v, v => v), []);
});

test("lettered corners follow the same transform and invert the offset Y", () => {
  const [marker] = cornerMarkers([{ number: 2, letter: "A", x: 5, y: 6, angle: 90 }], v => v * 10, v => 330 - v * 10);
  assert.equal(marker.label, "2A");
  assert.equal(marker.anchorX, 50);
  assert.equal(marker.anchorY, 270);
  assert.equal(marker.y, 250);
});

test("crowded badges stay separate and within SVG bounds", () => {
  const corners = Array.from({ length: 8 }, (_, i) => ({ number: i + 1, letter: "", x: 3, y: 3, angle: 0 }));
  const markers = cornerMarkers(corners, v => v, v => v);
  for (const [i, marker] of markers.entries()) {
    assert.ok(marker.x >= marker.radius && marker.x + marker.radius <= 700);
    assert.ok(marker.y >= marker.radius && marker.y + marker.radius <= 380);
    for (const other of markers.slice(0, i)) assert.ok(Math.hypot(marker.x - other.x, marker.y - other.y) >= marker.radius + other.radius);
  }
});
