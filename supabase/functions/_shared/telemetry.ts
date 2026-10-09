export const MAX_TELEMETRY_BYTES = 4 * 1024 * 1024;
export interface ChunkEntry {
  file: string;
  bytes: number;
  sha256: string;
}
export interface Manifest {
  chunks: ChunkEntry[];
  laps: {
    driver: string;
    lap: number;
    chunk: string | null;
    reason: string | null;
  }[];
}
export function validTelemetryFile(
  file: unknown,
  version: string,
): file is string {
  return (
    typeof file === "string" &&
    /^[a-f0-9]{20}$/.test(version) &&
    new RegExp(`^${version}\\.telemetry-\\d{4}\\.json$`).test(file)
  );
}
export function validChunk(raw: unknown, sessionId: string) {
  const value = raw as {
    schema_version?: number;
    session_id?: string;
    traces?: Record<string, unknown>[];
  } | null;
  const fields = [
    "distance",
    "time",
    "speed",
    "throttle",
    "brake",
    "gear",
    "rpm",
    "x",
    "y",
  ];
  return (
    !!value &&
    value.schema_version === 1 &&
    value.session_id === sessionId &&
    Array.isArray(value.traces) &&
    value.traces.length > 0 &&
    value.traces.every(
      (t) =>
        t &&
        typeof t.driver === "string" &&
        /^[A-Z0-9]{2,3}$/.test(t.driver) &&
        Number.isInteger(t.lap) &&
        Number(t.lap) > 0 &&
        typeof t.reliable === "boolean" &&
        typeof t.lap_time === "number" &&
        Number.isFinite(t.lap_time) &&
        fields.every(
          (f) =>
            Array.isArray(t[f]) &&
            (t[f] as unknown[]).length === 1000 &&
            (t[f] as unknown[]).every(
              (n) =>
                n === null || (typeof n === "number" && Number.isFinite(n)),
            ),
        ),
    )
  );
}
export function validateManifest(
  raw: unknown,
  version: string,
  laps: { driver: string; number: number }[],
): Manifest | null {
  if (raw == null) return null;
  const manifest = raw as Manifest;
  if (
    !Array.isArray(manifest.chunks) ||
    !Array.isArray(manifest.laps) ||
    manifest.chunks.length > 1000 ||
    manifest.laps.length !== laps.length
  )
    throw new Error("Invalid telemetry manifest");
  const files = new Set<string>();
  for (const c of manifest.chunks) {
    if (
      !c ||
      !validTelemetryFile(c.file, version) ||
      !Number.isInteger(c.bytes) ||
      c.bytes <= 0 ||
      c.bytes > MAX_TELEMETRY_BYTES ||
      !/^[a-f0-9]{64}$/.test(c.sha256) ||
      files.has(c.file)
    )
      throw new Error("Invalid telemetry chunk reference");
    files.add(c.file);
  }
  const lapKeys = new Set(laps.map((l) => `${l.driver}/${l.number}`));
  const seen = new Set<string>(),
    referenced = new Set<string>();
  for (const l of manifest.laps) {
    const key = `${l?.driver}/${l?.lap}`;
    if (
      !l ||
      !lapKeys.has(key) ||
      seen.has(key) ||
      (l.chunk !== null && !files.has(l.chunk)) ||
      (l.chunk === null && (typeof l.reason !== "string" || !l.reason))
    )
      throw new Error("Invalid telemetry lap reference");
    seen.add(key);
    if (l.chunk) referenced.add(l.chunk);
  }
  if (referenced.size !== files.size)
    throw new Error("Unreferenced telemetry chunk");
  return manifest;
}
export async function sha256(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function retainedObject(
  name: string,
  current: string,
  previous: string | null,
) {
  return [current, previous].some(
    (v) => v && (name === `${v}.json` || validTelemetryFile(name, v)),
  );
}

export async function verifyTelemetryDependencies(
  manifest: Manifest | null,
  sessionId: string,
  read: (file: string) => Promise<Uint8Array>,
) {
  const chunks = manifest?.chunks || [];
  for (let offset = 0; offset < chunks.length; offset += 4) {
    await Promise.all(
      chunks.slice(offset, offset + 4).map(async (c) => {
        const bytes = await read(c.file);
        if (bytes.byteLength !== c.bytes || (await sha256(bytes)) !== c.sha256)
          throw new Error("Incomplete telemetry publication");
        const chunk = JSON.parse(new TextDecoder().decode(bytes));
        if (!validChunk(chunk, sessionId))
          throw new Error("Invalid published telemetry");
        const indexed = manifest!.laps.filter((l) => l.chunk === c.file);
        if (
          chunk.traces.length !== indexed.length ||
          indexed.some(
            (l) =>
              !chunk.traces.some(
                (t: { driver: string; lap: number }) =>
                  t.driver === l.driver && t.lap === l.lap,
              ),
          )
        )
          throw new Error("Telemetry index mismatch");
      }),
    );
  }
  return chunks.reduce((total, chunk) => total + chunk.bytes, 0);
}
