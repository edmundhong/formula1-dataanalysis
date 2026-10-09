import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advancedPaceLaps,
  emptyAdvanced,
  lapFlags,
  parseAdvanced,
  phaseLabel,
  resolveSlot,
  selectableLaps,
  validateAdvanced,
} from "../lib/advanced";
import { dominance } from "../lib/analysis";
import {
  embeddedTrace,
  fetchTelemetryChunk,
  validateTelemetryChunk,
} from "../lib/telemetry";
import type { Analysis, Lap, Trace } from "../lib/types";

const lap = (
  driver: string,
  number: number,
  phase = "Q1",
  extra: Partial<Lap> = {},
): Lap => ({
  driver,
  number,
  phase,
  time: 90 + number,
  sectors: [30, 30, 30 + number],
  stint: 1,
  compound: "SOFT",
  tyre_age: number,
  fresh: true,
  deleted: false,
  accurate: true,
  track_status: "1",
  pit_in: null,
  pit_out: null,
  position: null,
  clean: true,
  ...extra,
});
const trace = (driver: string, lap: number, time = 90): Trace => ({
  driver,
  lap,
  phase: "Q1",
  lap_time: time,
  distance: Array.from({ length: 1000 }, (_, i) => i * 5),
  time: Array.from({ length: 1000 }, (_, i) => (i / 999) * time),
  speed: Array(1000).fill(200),
  throttle: Array(1000).fill(100),
  brake: Array(1000).fill(0),
  gear: Array(1000).fill(6),
  rpm: Array(1000).fill(10000),
  x: Array(1000).fill(0),
  y: Array(1000).fill(0),
  reliable: true,
  reason: null,
});
const data = {
  schema_version: 1,
  session_id: "2026-01-Q",
  phases: ["ALL", "Q1", "Q2", "Q3"],
  drivers: [{ code: "AAA" }, { code: "BBB" }],
  laps: [
    lap("AAA", 2),
    lap("AAA", 4, "Q2"),
    lap("AAA", 6, "Q3"),
    lap("BBB", 2),
    lap("AAA", 7, "Q3", { deleted: true }),
    lap("AAA", 8, "Q3", { pit_in: 900 }),
    lap("AAA", 9, "Q3", { accurate: false }),
  ],
  traces: [trace("AAA", 6)],
} as Analysis;

test("segments, eliminated drivers, flags and explicit laps resolve without substitution", () => {
  assert.equal(phaseLabel("Q2", "SQ"), "SQ2");
  assert.equal(
    resolveSlot(data, { driver: "BBB", phase: "Q3", lap: "fastest" }),
    undefined,
  );
  assert.equal(
    resolveSlot(data, { driver: "AAA", phase: "Q2", lap: "fastest" })?.number,
    4,
  );
  assert.equal(
    resolveSlot(data, { driver: "AAA", phase: "Q3", lap: 4 }),
    undefined,
  );
  const slot = { driver: "AAA", phase: "Q3", lap: "fastest" as const };
  assert.deepEqual(
    selectableLaps(data, slot, false).map((l) => l.number),
    [6],
  );
  assert.deepEqual(
    selectableLaps(data, slot, true).map((l) => l.number),
    [6, 7, 8, 9],
  );
  assert.deepEqual(
    resolveSlot(data, { ...slot, lap: 7 })?.sectors,
    [30, 30, 37],
  );
});
test("URL roundtrip preserves same-driver cross-segment laps and reference", () => {
  const value = {
    ...emptyAdvanced(),
    slots: [
      { driver: "AAA", phase: "Q1", lap: 2 },
      { driver: "AAA", phase: "Q3", lap: 6 },
    ],
    reference: 1,
  };
  assert.deepEqual(
    validateAdvanced(parseAdvanced(JSON.stringify(value)), data),
    value,
  );
  assert.deepEqual(
    validateAdvanced(parseAdvanced("broken"), data),
    emptyAdvanced(),
  );
  assert.equal(
    validateAdvanced({ ...value, reference: 99 }, data).reference,
    0,
  );
  assert.equal(
    validateAdvanced(
      { slots: [{ driver: "FOREIGN", phase: "ALL", lap: 1 }] },
      data,
    ).slots.length,
    0,
  );
  const missingReference = validateAdvanced(
    {
      ...value,
      slots: [{ driver: "FOREIGN", phase: "Q1", lap: 2 }, value.slots[1]],
      reference: 0,
    },
    data,
  );
  assert.equal(missingReference.reference, -1);
  assert.equal(validateAdvanced(missingReference, data).reference, -1);
  const missingPhase = validateAdvanced(
    { ...value, slots: [{ driver: "AAA", phase: "Q3", lap: "fastest" }] },
    {
      ...data,
      phases: ["ALL", "Q1"],
      laps: data.laps.filter((l) => l.phase === "Q1"),
    },
  );
  assert.equal(missingPhase.slots[0].phase, "Q3");
  assert.equal(
    resolveSlot(
      { ...data, laps: data.laps.filter((l) => l.phase === "Q1") },
      missingPhase.slots[0],
    ),
    undefined,
  );
});

test("disrupted and untimed laps stay flagged when opened for comparison", () => {
  for (const extra of [{ track_status: "2" }, { time: null }, { time: 0 }]) {
    const recorded = lap("AAA", 2, "Q1", extra);
    assert.ok(lapFlags(recorded));
    const analysis = { ...data, laps: [recorded] };
    const slot = { driver: "AAA", phase: "Q1", lap: 2 };
    assert.deepEqual(selectableLaps(analysis, slot, false), []);
    assert.deepEqual(selectableLaps(analysis, slot, true), [recorded]);
  }
});
test("independent pace filters and exclusions determine every included lap", () => {
  const filters = {
    AAA: {
      clean: true,
      compound: "ALL",
      stint: "ALL",
      from: 2,
      to: 6,
      excluded: [4],
    },
    BBB: {
      clean: false,
      compound: "SOFT",
      stint: "1",
      from: 1,
      to: 3,
      excluded: [],
    },
  };
  assert.deepEqual(
    advancedPaceLaps(data.laps, ["AAA", "BBB"], filters).map(
      (l) => `${l.driver}/${l.number}`,
    ),
    ["AAA/2", "AAA/6", "BBB/2"],
  );
  assert.equal(
    advancedPaceLaps(data.laps, ["AAA"], {
      AAA: { ...filters.AAA, excluded: [2, 4, 6] },
    }).length,
    0,
  );
  assert.equal(
    validateAdvanced(
      {
        pace: {
          AAA: { ...filters.AAA, from: -1, to: Infinity, excluded: [2, 100] },
        },
        paceActive: true,
      },
      data,
    ).pace.AAA.from,
    1,
  );
});
test("same-driver dominance distinguishes slots and refuses unreliable timing", () => {
  const one = { ...trace("AAA", 2, 90), comparison_id: "slot-0" },
    two = { ...trace("AAA", 6, 95), comparison_id: "slot-1" };
  assert.equal(dominance([one, two])[0].winner, "slot-0");
  assert.equal(dominance([one, { ...two, reliable: false }]).length, 0);
  assert.equal(embeddedTrace(data, data.laps[0]), undefined);
  assert.equal(embeddedTrace(data, data.laps[2])?.lap, 6);
});
test("telemetry validates session, samples, digest, missing files and abort signals", async () => {
  const content = {
    schema_version: 1,
    session_id: data.session_id,
    traces: [trace("AAA", 2)],
  };
  assert.equal(validateTelemetryChunk(content, data.session_id).length, 1);
  assert.throws(() => validateTelemetryChunk(content, "other"));
  assert.throws(() =>
    validateTelemetryChunk(
      { ...content, traces: [{ ...trace("AAA", 2), time: [] }] },
      data.session_id,
    ),
  );
  assert.throws(() =>
    validateTelemetryChunk(
      { ...content, traces: [{ ...trace("AAA", 2), lap: 0 }] },
      data.session_id,
    ),
  );
  assert.throws(() =>
    validateTelemetryChunk(
      { ...content, traces: [{ ...trace("AAA", 2), lap_time: null }] },
      data.session_id,
    ),
  );
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  const sha256 = Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  const file = `${"a".repeat(20)}.telemetry-0000.json`;
  const a = {
    ...data,
    telemetry_manifest: {
      chunks: [{ file, bytes: bytes.length, sha256 }],
      laps: [],
    },
  };
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => {
      assert.ok(init?.signal);
      return new Response(bytes);
    };
    assert.equal(
      (
        await fetchTelemetryChunk(
          "http://local/file",
          a,
          file,
          new AbortController().signal,
        )
      )[0].lap,
      2,
    );
    globalThis.fetch = async () => new Response("missing", { status: 404 });
    await assert.rejects(
      fetchTelemetryChunk("http://local/file", a, file),
      /could not be loaded/,
    );
    globalThis.fetch = async () => new Response(new Uint8Array(bytes.length));
    await assert.rejects(
      fetchTelemetryChunk("http://local/file", a, file),
      /verification/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
