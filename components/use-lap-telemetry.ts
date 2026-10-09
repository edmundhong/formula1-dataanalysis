"use client";
import { useEffect, useMemo, useState } from "react";
import { resolveSlot } from "@/lib/advanced";
import { telemetryUrl } from "@/lib/data";
import {
  embeddedTrace,
  fetchTelemetryChunk,
  telemetryFile,
} from "@/lib/telemetry";
import type { Analysis, ComparisonSlot, Session, Trace } from "@/lib/types";

export function useLapTelemetry(
  data: Analysis,
  session: Session,
  slots: ComparisonSlot[],
) {
  const [loaded, setLoaded] = useState<{
    identity: string;
    fileKey: string;
    done: boolean;
    traces: Trace[];
    errors: Record<string, string>;
  }>({ identity: "", fileKey: "", done: false, traces: [], errors: {} });
  const [retry, setRetry] = useState(0);
  const identity = `${data.session_id}/${session.version}`;
  const laps = useMemo(
    () => slots.map((s) => resolveSlot(data, s)),
    [data, slots],
  );
  const files = [
    ...new Set(
      laps.flatMap((l) =>
        l && !embeddedTrace(data, l) && telemetryFile(data, l)?.chunk
          ? [telemetryFile(data, l)!.chunk!]
          : [],
      ),
    ),
  ].sort();
  const fileKey = files.join(",");
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoaded({ identity, fileKey, done: false, traces: [], errors: {} });
    async function load() {
      const results = await Promise.allSettled(
        files.map(async (file) =>
          fetchTelemetryChunk(
            telemetryUrl(session, file),
            data,
            file,
            controller.signal,
          ),
        ),
      );
      if (!active) return;
      const traces: Trace[] = [],
        errors: Record<string, string> = {};
      results.forEach((result, i) => {
        if (result.status === "fulfilled") traces.push(...result.value);
        else
          errors[files[i]] =
            result.reason instanceof Error
              ? result.reason.message
              : "Telemetry could not be loaded.";
      });
      setLoaded({ identity, fileKey, done: true, traces, errors });
    }
    load();
    return () => {
      active = false;
      controller.abort();
    };
    // Files and immutable session version completely identify the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, fileKey, retry]);
  const current =
    loaded.identity === identity && loaded.fileKey === fileKey
      ? loaded
      : { done: false, traces: [], errors: {} as Record<string, string> };
  const rows = laps.map((lap, index) => {
    const manifest = lap ? telemetryFile(data, lap) : undefined;
    const trace = lap
      ? embeddedTrace(data, lap) ||
        current.traces.find(
          (t) => t.driver === lap.driver && t.lap === lap.number,
        )
      : undefined;
    return {
      lap,
      trace: trace
        ? {
            ...trace,
            comparison_id: `slot-${index}`,
            label: `${trace.driver} · Lap ${trace.lap}`,
          }
        : undefined,
      status: trace
        ? trace.reliable
          ? "Telemetry available"
          : "Telemetry available · unreliable timing"
        : !lap
          ? "Lap unavailable"
          : manifest?.chunk
            ? current.errors[manifest.chunk] ||
              (current.done
                ? "Lap absent from telemetry file"
                : "Loading telemetry…")
            : manifest?.reason || "Telemetry unavailable in this artifact",
    };
  });
  return {
    rows,
    retry: () => setRetry((n) => n + 1),
    failed: Object.keys(current.errors).length > 0,
  };
}
