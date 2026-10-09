import type { Analysis, Lap, Trace } from "./types";
import { validChunk } from "../supabase/functions/_shared/telemetry";

export function embeddedTrace(data: Analysis, lap: Lap) {
  return data.traces.find(
    (t) => t.driver === lap.driver && t.lap === lap.number,
  );
}
export function telemetryFile(data: Analysis, lap: Lap) {
  return data.telemetry_manifest?.laps.find(
    (l) => l.driver === lap.driver && l.lap === lap.number,
  );
}
export function validateTelemetryChunk(
  raw: unknown,
  sessionId: string,
): Trace[] {
  const chunk = raw as {
    schema_version?: number;
    session_id?: string;
    traces?: Trace[];
  } | null;
  if (
    !chunk ||
    chunk.schema_version !== 1 ||
    chunk.session_id !== sessionId ||
    !Array.isArray(chunk.traces)
  )
    throw new Error("Unsupported telemetry file.");
  if (!validChunk(chunk, sessionId))
    throw new Error("Invalid telemetry samples.");
  return chunk.traces;
}
export async function fetchTelemetryChunk(
  url: string,
  data: Analysis,
  file: string,
  signal?: AbortSignal,
): Promise<Trace[]> {
  const entry = data.telemetry_manifest?.chunks.find((c) => c.file === file);
  if (
    !entry ||
    !/^[a-f0-9]{20}\.telemetry-\d{4}\.json$/.test(file) ||
    entry.bytes > 4 * 1024 * 1024
  )
    throw new Error("Invalid telemetry manifest.");
  const response = await fetch(url, { cache: "force-cache", signal });
  if (!response.ok)
    throw new Error("Telemetry could not be loaded. Retry this comparison.");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== entry.bytes)
    throw new Error("Incomplete telemetry file.");
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== entry.sha256)
    throw new Error("Telemetry file verification failed.");
  return validateTelemetryChunk(
    JSON.parse(new TextDecoder().decode(bytes)),
    data.session_id,
  );
}
