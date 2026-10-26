import { test } from "node:test";
import assert from "node:assert/strict";
import { timingTrace, trackGeometry } from "../lib/trace-quality";
import { dominance, selectedTraces } from "../lib/analysis";
import { embeddedTrace } from "../lib/telemetry";
import type { Analysis, Trace } from "../lib/types";

function fixture() {
  const ant = {
    driver: "ANT", lap: 14, phase: "Q3", lap_time: 94.035,
    distance: Array.from({ length: 1000 }, (_, i) => i * 5),
    time: Array.from({ length: 1000 }, (_, i) => i * 94.035 / 999),
    x: Array.from({ length: 1000 }, (_, i) => i < 978 ? i : null),
    y: Array.from({ length: 1000 }, (_, i) => i),
    reliable: false, reason: "Position coverage or lap validity could not be verified.",
  } as Trace;
  ant.time.fill(null, 400, 416);
  const ver = { ...ant, driver: "VER", lap: 8, reliable: true, reason: null,
    time: Array.from({ length: 1000 }, (_, i) => i * 94.214 / 999), x: [...ant.y] };
  const data = { provenance: { source: "OpenF1", adapter_version: 1 },
    traces: [ant, ver], laps: [{ driver: "ANT", number: 14, time: 94.035,
      sectors: [25.31, 37.297, 31.428], deleted: false, quality: { issues: [] } }],
  } as unknown as Analysis;
  return { data, ant, ver };
}

test("ANT Q3 timing survives position gaps and uses VER geometry", () => {
  const { data, ant, ver } = fixture();
  const traces = selectedTraces(data, ["ANT", "VER"], "Q3");
  assert.equal(traces[0].reliable, true);
  assert.equal(embeddedTrace(data, data.laps[0])?.reliable, true);
  assert.equal(trackGeometry(traces), ver);
  assert.equal(dominance(traces).length, 50);
  assert.ok(dominance(traces).some((s) => s.times.length === 0));
  assert.ok(dominance(traces).some((s) => s.times.length === 2));
  assert.equal(ant.reliable, false); // Immutable stored artifact.
});

test("legacy recovery still rejects timing, coverage and validity failures", () => {
  const checks = [
    ({ ant }: ReturnType<typeof fixture>) => { ant.time.fill(null, 400, 421); },
    ({ ant }: ReturnType<typeof fixture>) => { ant.time[999] = 93; },
    ({ ant }: ReturnType<typeof fixture>) => { ant.time[5] = -1; },
    ({ data }: ReturnType<typeof fixture>) => { data.laps[0].quality!.issues.push("validity_unverified"); },
    ({ data }: ReturnType<typeof fixture>) => { data.laps[0].deleted = true; },
    ({ data }: ReturnType<typeof fixture>) => { data.laps[0].sectors[0] = null; },
    ({ data }: ReturnType<typeof fixture>) => { data.provenance.source = "FastF1"; },
  ];
  for (const change of checks) {
    const f = fixture();
    change(f);
    assert.equal(timingTrace(f.data, f.ant).reliable, false);
  }
});
