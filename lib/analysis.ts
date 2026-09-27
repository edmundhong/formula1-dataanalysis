import type { Analysis, Lap, Trace } from "./types";
export const compoundColors: Record<string, string> = {
  SOFT: "#ee454e",
  MEDIUM: "#eebc3f",
  HARD: "#adb4c2",
  INTERMEDIATE: "#4bbd79",
  WET: "#4b92e3",
  UNKNOWN: "#7e8798",
};
export function formatTime(t: number | null | undefined) {
  return t == null || !Number.isFinite(t)
    ? "—"
    : `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, "0")}`;
}
export function median(v: number[]) {
  const a = v.filter(Number.isFinite).sort((a, b) => a - b);
  const m = Math.floor(a.length / 2);
  return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : null;
}
export function bestLaps(laps: Lap[], phase = "ALL") {
  const best = new Map<string, Lap>();
  for (const l of laps)
    if (
      l.time != null &&
      l.time > 0 &&
      !l.deleted &&
      l.pit_in == null &&
      l.pit_out == null &&
      (phase === "ALL" || l.phase === phase)
    ) {
      if (!best.has(l.driver) || l.time < best.get(l.driver)!.time!)
        best.set(l.driver, l);
    }
  return [...best.values()].sort(
    (a, b) => a.time! - b.time! || a.driver.localeCompare(b.driver),
  );
}
export interface PaceFilters {
  drivers: string[];
  compound: string;
  stint: string;
  from: number;
  to: number;
  clean: boolean;
}
export function paceLaps(laps: Lap[], f: PaceFilters) {
  return laps.filter(
    (l) =>
      l.time != null &&
      l.time > 0 &&
      (!f.clean || l.clean) &&
      f.drivers.includes(l.driver) &&
      (f.compound === "ALL" || l.compound === f.compound) &&
      (f.stint === "ALL" || l.stint === Number(f.stint)) &&
      l.number >= f.from &&
      l.number <= f.to,
  );
}
export function selectedTraces(a: Analysis, drivers: string[], phase: string) {
  return drivers
    .map((d) => a.traces.find((t) => t.driver === d && t.phase === phase))
    .filter((t): t is Trace => !!t);
}
export interface DominanceSection {
  index: number;
  winner: string | null;
  tied: boolean;
  times: { driver: string; seconds: number }[];
  advantage: number | null;
  start: number;
  end: number;
}
export function dominance(traces: Trace[]): DominanceSection[] {
  if (
    traces.length < 2 ||
    traces.some((t) => !t.reliable || t.time.length !== 1000)
  )
    return [];
  return Array.from({ length: 50 }, (_, i) => {
    const start = Math.round((i * 999) / 50),
      end = Math.round(((i + 1) * 999) / 50);
    const valid = traces.every((t) =>
      t.time
        .slice(start, end + 1)
        .every((v) => v != null && Number.isFinite(v)),
    );
    const times = valid
      ? traces
          .map((t) => ({
            driver: t.driver,
            seconds: t.time[end]! - t.time[start]!,
          }))
          .sort((a, b) => a.seconds - b.seconds)
      : [];
    const advantage = times.length ? times[1].seconds - times[0].seconds : null;
    return {
      index: i,
      start,
      end,
      times,
      advantage,
      tied: advantage != null && advantage < 0.01,
      winner: advantage != null && advantage >= 0.01 ? times[0].driver : null,
    };
  });
}
