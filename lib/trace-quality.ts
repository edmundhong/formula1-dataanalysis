import type { Analysis, Trace } from "./types";

// Adapter v1 combined position coverage with timing reliability. Recover only
// that known case, rechecking timing and validity against the recorded lap.
export function timingTrace(data: Analysis, trace: Trace): Trace {
  if (trace.reliable || data.provenance.source !== "OpenF1" ||
      data.provenance.adapter_version !== 1 ||
      trace.reason !== "Position coverage or lap validity could not be verified.") return trace;
  const lap = data.laps.find((l) => l.driver === trace.driver && l.number === trace.lap);
  const times = trace.time.filter((t): t is number => t != null && Number.isFinite(t));
  if (!lap || !lap.quality || lap.quality.issues.length || lap.deleted ||
      lap.time == null || lap.time <= 0 || trace.lap_time !== lap.time ||
      trace.time.length !== 1000 || times.length < 980 ||
      trace.time[0] == null || trace.time[999] == null ||
      Math.abs(trace.time[0]) > 0.15 || Math.abs(trace.time[999] - lap.time) > 0.15 ||
      times.some((t, i) => i > 0 && t <= times[i - 1]) ||
      trace.distance.length !== 1000 || trace.distance.some((d, i) =>
        !Number.isFinite(d) || (i > 0 && d <= trace.distance[i - 1])) ||
      lap.sectors.some((s) => s == null || !Number.isFinite(s)) ||
      Math.abs(lap.sectors.reduce<number>((sum, s) => sum + (s ?? 0), 0) - lap.time) > 0.15) return trace;
  return { ...trace, reliable: true, reason: null };
}

export function trackGeometry(traces: Trace[]): Trace | undefined {
  // Geometry is only the shared drawing surface; timing still comes from each
  // selected lap. Prefer the most complete outline without changing lap order.
  return traces.reduce<Trace | undefined>((best, trace) =>
    !best || coverage(trace) > coverage(best) ? trace : best, undefined);
}

function coverage(trace: Trace) {
  return trace.x.reduce<number>((count, x, i) => count +
    (x != null && Number.isFinite(x) && trace.y[i] != null && Number.isFinite(trace.y[i]) ? 1 : 0), 0);
}
