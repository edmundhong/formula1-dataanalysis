import { median } from "./analysis";
import type { Analysis, Lap } from "./types";

export function sectorRankings(laps: Lap[], drivers: string[], metric: "median" | "fastest") {
  return [0, 1, 2].map((sector) => drivers.flatMap((driver) => {
    const values = laps.filter((lap) => lap.driver === driver)
      .map((lap) => lap.sectors[sector])
      .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
    if (!values.length) return [];
    return [{ driver, seconds: metric === "median" ? median(values)! : Math.min(...values) }];
  }).sort((a, b) => a.seconds - b.seconds || a.driver.localeCompare(b.driver)).slice(0, 3));
}

// Locate timing lines on a single matching lap, never by dividing track length in thirds.
export function sectorGeometry(data: Pick<Analysis, "traces" | "laps">) {
  for (const trace of data.traces) {
    if (!trace.reliable) continue;
    const lap = data.laps.find((l) => l.driver === trace.driver && l.number === trace.lap);
    if (!lap || lap.sectors.length !== 3 || !lap.sectors.every((s) => s != null && Number.isFinite(s) && s > 0)) continue;
    const samples = trace.time.map((time, i) => ({ time, x: trace.x[i], y: trace.y[i] }));
    if (samples.length < 4 || samples.some((p, i) =>
      p.time == null || p.x == null || p.y == null || ![p.time, p.x, p.y].every(Number.isFinite) ||
      (i > 0 && p.time <= samples[i - 1].time!))) continue;
    const points = samples as { time: number; x: number; y: number }[];
    const boundaries = [lap.sectors[0]!, lap.sectors[0]! + lap.sectors[1]!];
    if (boundaries[0] <= points[0].time || boundaries[1] >= points.at(-1)!.time) continue;
    const at = (time: number) => {
      const i = points.findIndex((p) => p.time >= time);
      const a = points[i - 1], b = points[i];
      const f = (time - a.time) / (b.time - a.time);
      return { time, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    };
    const cuts = [points[0], ...boundaries.map(at), points.at(-1)!];
    return [0, 1, 2].map((i) => [cuts[i], ...points.filter((p) => p.time > cuts[i].time && p.time < cuts[i + 1].time), cuts[i + 1]]);
  }
  return null;
}
