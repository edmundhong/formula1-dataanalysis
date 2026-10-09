import type { Corner } from "./types";

/** Place badges in SVG coordinates, accounting for the map's inverted Y axis. */
export function cornerMarkers(corners: Corner[] | undefined, x: (v: number) => number, y: (v: number) => number) {
  const placed: { label: string; x: number; y: number; anchorX: number; anchorY: number; radius: number }[] = [];
  for (const corner of corners ?? []) {
    if (!corner || !Number.isInteger(corner.number) || corner.number <= 0 || !Number.isFinite(corner.x) || !Number.isFinite(corner.y)) continue;
    const label = `${corner.number}${corner.letter || ""}`;
    if (placed.some(marker => marker.label === label)) continue;
    const radius = Math.max(10, label.length * 3.5 + 3);
    const anchorX = x(corner.x), anchorY = y(corner.y);
    const angle = (Number.isFinite(corner.angle) ? corner.angle : 0) * Math.PI / 180;
    let best = { x: anchorX, y: anchorY, score: Infinity };
    for (const distance of [20, 32, 44, 56, 68, 80, 96, 112, 144, 176]) {
      for (const offset of [0, ...Array.from({ length: 7 }, (_, i) => (i + 1) * Math.PI / 8).flatMap(v => [v, -v]), Math.PI]) {
        const cx = Math.max(radius + 4, Math.min(700 - radius - 4, anchorX + Math.cos(angle + offset) * distance));
        const cy = Math.max(radius + 4, Math.min(380 - radius - 4, anchorY - Math.sin(angle + offset) * distance));
        const overlap = placed.reduce((sum, marker) => sum + Math.max(0, radius + marker.radius + 4 - Math.hypot(cx - marker.x, cy - marker.y)), 0);
        const score = overlap * 1000 + distance + Math.abs(offset) * 4;
        if (score < best.score) best = { x: cx, y: cy, score };
      }
    }
    placed.push({ label, x: best.x, y: best.y, anchorX, anchorY, radius });
  }
  return placed;
}
