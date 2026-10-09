import { test } from "node:test";
import assert from "node:assert/strict";
import {
  retainedObject,
  sha256,
  validChunk,
  validTelemetryFile,
  validateManifest,
  verifyTelemetryDependencies,
} from "../supabase/functions/_shared/telemetry";

const version = "a".repeat(20),
  previous = "b".repeat(20);
const file = `${version}.telemetry-0000.json`;
const trace = {
  driver: "AAA",
  lap: 2,
  phase: "Q1",
  lap_time: 90,
  reliable: true,
  reason: null,
  ...Object.fromEntries(
    [
      "distance",
      "time",
      "speed",
      "throttle",
      "brake",
      "gear",
      "rpm",
      "x",
      "y",
    ].map((c) => [c, Array(1000).fill(0)]),
  ),
};
const payload = { schema_version: 1, session_id: "2026-01-Q", traces: [trace] };
test("manifest only references bounded files from its version and recorded laps", () => {
  assert.equal(validTelemetryFile(file, version), true);
  assert.equal(validTelemetryFile(`../${file}`, version), false);
  assert.equal(validTelemetryFile(file, previous), false);
  const manifest = {
    chunks: [{ file, bytes: 100, sha256: "a".repeat(64) }],
    laps: [{ driver: "AAA", lap: 2, chunk: file, reason: null }],
  };
  assert.deepEqual(
    validateManifest(manifest, version, [{ driver: "AAA", number: 2 }]),
    manifest,
  );
  assert.throws(() =>
    validateManifest(manifest, previous, [{ driver: "AAA", number: 2 }]),
  );
  assert.throws(() =>
    validateManifest(manifest, version, [{ driver: "BBB", number: 2 }]),
  );
  assert.throws(() =>
    validateManifest(
      { ...manifest, chunks: [{ ...manifest.chunks[0], bytes: 4194305 }] },
      version,
      [{ driver: "AAA", number: 2 }],
    ),
  );
  assert.equal(validateManifest(undefined, version, []), null);
  assert.equal(validChunk(payload, payload.session_id), true);
  assert.equal(validChunk(payload, "foreign"), false);
});
test("publication verifies all dependencies before commit and counts their storage", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const manifest = {
    chunks: [{ file, bytes: bytes.byteLength, sha256: await sha256(bytes) }],
    laps: [{ driver: "AAA", lap: 2, chunk: file, reason: null }],
  };
  assert.equal(
    await verifyTelemetryDependencies(
      manifest,
      payload.session_id,
      async () => bytes,
    ),
    bytes.byteLength,
  );
  await assert.rejects(
    verifyTelemetryDependencies(manifest, payload.session_id, async () => {
      throw new Error("Upload missing");
    }),
    /missing/,
  );
  await assert.rejects(
    verifyTelemetryDependencies(
      manifest,
      payload.session_id,
      async () => new Uint8Array(bytes.length),
    ),
    /Incomplete/,
  );
  await assert.rejects(
    verifyTelemetryDependencies(
      { ...manifest, laps: [{ ...manifest.laps[0], lap: 3 }] },
      payload.session_id,
      async () => bytes,
    ),
    /index mismatch/,
  );
  assert.equal(
    await verifyTelemetryDependencies(
      null,
      payload.session_id,
      async () => bytes,
    ),
    0,
  );
});
test("cleanup retains the current and previous versions including telemetry files", () => {
  assert.equal(retainedObject(file, version, previous), true);
  assert.equal(
    retainedObject(`${previous}.telemetry-0001.json`, version, previous),
    true,
  );
  assert.equal(retainedObject(`${version}.json`, version, previous), true);
  assert.equal(
    retainedObject(`${"c".repeat(20)}.telemetry-0000.json`, version, previous),
    false,
  );
});
