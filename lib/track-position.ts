import type { Trace } from "./types";

// Charts use the selected reference lap's distance, while the map uses the
// first trace's geometry. Their samples represent the same normalized lap position.
export function trackPosition(geometry: Pick<Trace, "x" | "y">, distances: number[], distance: number | null) {
  if (distance == null || !Number.isFinite(distance) || distances.length < 2 ||
      distance < distances[0] || distance > distances[distances.length - 1]) return null;
  let right = distances.findIndex((value) => value >= distance);
  if (right < 0) return null;
  right = Math.max(1, right);
  const left = right - 1;
  const span = distances[right] - distances[left];
  const fraction = span > 0 ? (distance - distances[left]) / span : 0;
  const x0 = geometry.x[left], x1 = geometry.x[right];
  const y0 = geometry.y[left], y1 = geometry.y[right];
  if ([x0, x1, y0, y1].some((value) => value == null || !Number.isFinite(value))) return null;
  return {
    x: x0! + (x1! - x0!) * fraction,
    y: y0! + (y1! - y0!) * fraction,
    index: left + fraction,
  };
}
