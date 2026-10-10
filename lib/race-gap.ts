import type { Lap } from "./types";

export type RaceGapReference = "session" | "selection";
export interface RaceGapPoint {
  lap: number;
  gap: number | null;
  reference: string | null;
}

/** Compare finish-line timestamps at equal completed distance, never filtered pace. */
export function raceGaps(
  laps: Lap[],
  selected: string[],
  reference: RaceGapReference = "session",
): { driver: string; points: RaceGapPoint[] }[] {
  const selectedSet = new Set(selected);
  const leaders = new Map<number, Lap>();
  const validTime = (lap: Lap) =>
    lap.end_time != null && Number.isFinite(lap.end_time) && lap.end_time >= 0;
  for (const lap of laps) {
    if (!validTime(lap) || (reference === "selection" && !selectedSet.has(lap.driver))) continue;
    const current = leaders.get(lap.number);
    if (!current || lap.end_time! < current.end_time! ||
      (lap.end_time === current.end_time && lap.driver.localeCompare(current.driver) < 0)) {
      leaders.set(lap.number, lap);
    }
  }
  return selected.map((driver) => {
    const driverLaps = laps.filter((lap) => lap.driver === driver);
    const byNumber = new Map(driverLaps.map((lap) => [lap.number, lap]));
    const first = Math.min(...driverLaps.map((lap) => lap.number));
    const last = Math.max(...driverLaps.map((lap) => lap.number));
    const points: RaceGapPoint[] = [];
    for (let number = first; number <= last; number++) {
      const lap = byNumber.get(number);
      const leader = leaders.get(number);
      points.push({
        lap: number,
        gap: lap && validTime(lap) && leader ? lap.end_time! - leader.end_time! : null,
        reference: leader?.driver ?? null,
      });
    }
    return { driver, points };
  });
}
