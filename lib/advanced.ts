import { bestLaps, paceLaps } from "./analysis";
import type {
  AdvancedSelection,
  Analysis,
  ComparisonSlot,
  DriverPaceSelection,
  Lap,
} from "./types";

export const emptyAdvanced = (): AdvancedSelection => ({
  slots: [],
  reference: 0,
  flagged: false,
  pace: {},
  paceActive: false,
});
export const phaseLabel = (phase: string, code: string) =>
  phase === "ALL"
    ? "Whole session"
    : code === "SQ"
      ? phase.replace(/^Q/, "SQ")
      : phase;
export function lapFlags(lap: Lap) {
  return [
    lap.deleted && "Deleted",
    !lap.accurate && "Inaccurate",
    lap.pit_in != null && "Pit in",
    lap.pit_out != null && "Pit out",
    lap.track_status !== "1" && "Disrupted",
    lap.time == null
      ? "No time"
      : (!Number.isFinite(lap.time) || lap.time <= 0) && "Invalid time",
  ]
    .filter(Boolean)
    .join(" · ");
}
export function selectableLaps(
  data: Analysis,
  slot: ComparisonSlot,
  flagged: boolean,
) {
  return data.laps
    .filter(
      (l) =>
        l.driver === slot.driver &&
        (slot.phase === "ALL" || slot.phase === l.phase) &&
        (flagged || (l.time != null && l.time > 0 && !lapFlags(l))),
    )
    .sort((a, b) => a.number - b.number);
}
export function resolveSlot(
  data: Analysis,
  slot: ComparisonSlot,
): Lap | undefined {
  return slot.lap === "fastest"
    ? bestLaps(selectableLaps(data, slot, false), slot.phase).find(
        (l) => l.driver === slot.driver,
      )
    : data.laps.find(
        (l) =>
          l.driver === slot.driver &&
          l.number === slot.lap &&
          (slot.phase === "ALL" || l.phase === slot.phase),
      );
}
export function advancedPaceLaps(
  laps: Lap[],
  drivers: string[],
  selections: Record<string, DriverPaceSelection>,
) {
  return drivers.flatMap((driver) => {
    const f = selections[driver];
    return f
      ? paceLaps(laps, { ...f, drivers: [driver] }).filter(
          (l) => !f.excluded.includes(l.number),
        )
      : [];
  });
}
export function parseAdvanced(raw: string | null): unknown {
  try {
    return raw && raw.length <= 16000 ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
// URL state is untrusted. Preserve an explicit unavailable choice instead of substituting another lap.
export function validateAdvanced(
  raw: unknown,
  data: Analysis,
): AdvancedSelection {
  const value = raw as Partial<AdvancedSelection> | null;
  if (!value || typeof value !== "object") return emptyAdvanced();
  const drivers = data.drivers.map((d) => d.code);
  const rawSlots = Array.isArray(value.slots) ? value.slots.slice(0, 4) : [];
  const validSlots = rawSlots
    .map((slot, index) => ({ slot, index }))
    .filter(
      ({ slot: s }) =>
        s &&
        drivers.includes(s.driver) &&
        ["ALL", "Q1", "Q2", "Q3"].includes(s.phase) &&
        (s.lap === "fastest" || (Number.isInteger(s.lap) && Number(s.lap) > 0)),
    );
  const slots: ComparisonSlot[] = validSlots.map(({ slot: s }) => ({
    driver: s.driver,
    phase: s.phase,
    lap: s.lap,
  }));
  const requestedReference =
    Number.isInteger(value.reference) &&
    Number(value.reference) >= -1 &&
    Number(value.reference) < rawSlots.length
      ? Number(value.reference)
      : 0;
  const reference = slots.length
    ? validSlots.findIndex((s) => s.index === requestedReference)
    : 0;
  const pace: Record<string, DriverPaceSelection> = {};
  const max = Math.max(1, ...data.laps.map((l) => l.number));
  for (const driver of drivers) {
    const f = value.pace?.[driver];
    if (!f || typeof f !== "object") continue;
    const laps = data.laps.filter((l) => l.driver === driver);
    const clamp = (n: unknown, fallback: number) =>
      typeof n === "number" && Number.isFinite(n)
        ? Math.max(1, Math.min(max, Math.trunc(n)))
        : fallback;
    const from = clamp(f.from, 1),
      to = Math.max(from, clamp(f.to, max));
    pace[driver] = {
      clean: f.clean !== false,
      compound: laps.some((l) => l.compound === f.compound)
        ? f.compound
        : "ALL",
      stint: laps.some((l) => String(l.stint) === f.stint) ? f.stint : "ALL",
      from,
      to,
      excluded: Array.isArray(f.excluded)
        ? [
            ...new Set(
              f.excluded.filter(
                (n) => Number.isInteger(n) && laps.some((l) => l.number === n),
              ),
            ),
          ]
        : [],
    };
  }
  return {
    slots,
    reference,
    flagged: value.flagged === true,
    pace,
    paceActive: value.paceActive === true,
  };
}
