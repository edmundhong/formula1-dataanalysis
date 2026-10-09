"use client";
import type { ReactNode } from "react";
import {
  advancedPaceLaps,
  lapFlags,
  phaseLabel,
  resolveSlot,
  selectableLaps,
} from "@/lib/advanced";
import { formatTime } from "@/lib/analysis";
import type {
  AdvancedSelection,
  Analysis,
  ComparisonSlot,
  DriverPaceSelection,
  Lap,
} from "@/lib/types";

function Disclosure({
  summary,
  children,
}: {
  summary: string;
  children: ReactNode;
}) {
  return (
    <details className="advanced-selection">
      <summary>
        <strong>Advanced selection</strong>
        <span>{summary}</span>
      </summary>
      <div className="advanced-body">{children}</div>
    </details>
  );
}
export function LapSelection({
  data,
  code,
  selected,
  phase,
  value,
  onChange,
}: {
  data: Analysis;
  code: string;
  selected: string[];
  phase: string;
  value: AdvancedSelection;
  onChange: (v: AdvancedSelection) => void;
}) {
  const initialize = () =>
    onChange({
      ...value,
      slots: selected.map((driver) => ({ driver, phase, lap: "fastest" })),
      reference: 0,
    });
  const update = (index: number, change: Partial<ComparisonSlot>) =>
    onChange({
      ...value,
      slots: value.slots.map((s, i) => (i === index ? { ...s, ...change } : s)),
    });
  return (
    <Disclosure
      summary={
        value.slots.length
          ? `${value.slots.length} laps selected · ${value.reference >= 0 ? `reference ${value.reference + 1}` : "reference unavailable"}`
          : "Fastest laps · default"
      }
    >
      <div className="advanced-actions">
        <button className="text-button" onClick={initialize}>
          {value.slots.length
            ? "Use selected drivers’ fastest laps"
            : "Choose comparison laps"}
        </button>
        <button
          className="text-button"
          onClick={() =>
            onChange({ ...value, slots: [], reference: 0, flagged: false })
          }
        >
          Reset lap selection
        </button>
      </div>
      {!!value.slots.length && (
        <>
          <label className="check-label">
            <input
              type="checkbox"
              checked={value.flagged}
              onChange={(e) =>
                onChange({ ...value, flagged: e.target.checked })
              }
            />
            Include flagged laps
          </label>
          {value.slots.map((slot, index) => {
            const laps = selectableLaps(data, slot, value.flagged);
            const lap = resolveSlot(data, slot);
            const unavailable =
              typeof slot.lap === "number" &&
              !laps.some((l) => l.number === slot.lap);
            return (
              <fieldset className="advanced-row" key={index}>
                <legend>Comparison {index + 1}</legend>
                <label>
                  Driver
                  <select
                    value={slot.driver}
                    onChange={(e) =>
                      update(index, { driver: e.target.value, lap: "fastest" })
                    }
                  >
                    {data.drivers.map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.code} · {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                {(data.phases.length > 1 || slot.phase !== "ALL") && (
                  <label>
                    Segment
                    <select
                      value={slot.phase}
                      onChange={(e) =>
                        update(index, { phase: e.target.value, lap: "fastest" })
                      }
                    >
                      {!data.phases.includes(slot.phase) && (
                        <option value={slot.phase}>
                          {phaseLabel(slot.phase, code)} · unavailable
                        </option>
                      )}
                      {data.phases.map((p) => (
                        <option key={p} value={p}>
                          {phaseLabel(p, code)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="lap-select">
                  Lap
                  <select
                    value={slot.lap}
                    onChange={(e) =>
                      update(index, {
                        lap:
                          e.target.value === "fastest"
                            ? "fastest"
                            : Number(e.target.value),
                      })
                    }
                  >
                    <option value="fastest">Fastest in segment</option>
                    {unavailable && (
                      <option value={slot.lap}>
                        Lap {slot.lap} · unavailable or flagged
                      </option>
                    )}
                    {laps.map((l) => (
                      <option key={l.number} value={l.number}>
                        Lap {l.number} · {formatTime(l.time)} · {l.compound} ·
                        age {l.tyre_age ?? "?"}
                        {lapFlags(l) ? ` · ${lapFlags(l)}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="check-label">
                  <input
                    type="radio"
                    name="lap-reference"
                    checked={value.reference === index}
                    onChange={() => onChange({ ...value, reference: index })}
                  />
                  Delta reference
                </label>
                <button
                  className="text-button"
                  onClick={() =>
                    onChange({
                      ...value,
                      slots: value.slots.filter((_, i) => i !== index),
                      reference:
                        value.reference === index
                          ? -1
                          : value.reference > index
                            ? value.reference - 1
                            : value.reference,
                    })
                  }
                >
                  Remove
                </button>
                <p className="selection-detail">
                  {lap
                    ? `${slot.driver} · Lap ${lap.number} · ${formatTime(lap.time)} · ${lap.compound} · tyre age ${lap.tyre_age ?? "unknown"} · ${lapFlags(lap) || "Valid timing"}`
                    : "No lap available in this segment."}
                </p>
              </fieldset>
            );
          })}
          {value.slots.length < 4 && (
            <button
              className="text-button"
              onClick={() =>
                onChange({
                  ...value,
                  slots: [
                    ...value.slots,
                    {
                      driver: selected[0] || data.drivers[0].code,
                      phase,
                      lap: "fastest",
                    },
                  ],
                })
              }
            >
              Add comparison lap
            </button>
          )}
        </>
      )}
    </Disclosure>
  );
}
export function PaceSelection({
  data,
  selected,
  defaults,
  value,
  onChange,
  onCompare,
}: {
  data: Analysis;
  selected: string[];
  defaults: Omit<DriverPaceSelection, "excluded">;
  value: AdvancedSelection;
  onChange: (v: AdvancedSelection) => void;
  onCompare: (lap: Lap) => void;
}) {
  const initialize = () =>
    onChange({
      ...value,
      paceActive: true,
      pace: Object.fromEntries(
        selected.map((d) => [
          d,
          {
            ...defaults,
            to: Math.min(
              defaults.to,
              Math.max(1, ...data.laps.map((l) => l.number)),
            ),
            excluded: [],
          },
        ]),
      ),
    });
  const update = (driver: string, f: DriverPaceSelection) =>
    onChange({ ...value, pace: { ...value.pace, [driver]: f } });
  return (
    <Disclosure
      summary={
        value.paceActive
          ? `${advancedPaceLaps(data.laps, selected, value.pace).length} laps · independent driver selections`
          : "Shared pace filters · default"
      }
    >
      <div className="advanced-actions">
        <button className="text-button" onClick={initialize}>
          {value.paceActive
            ? "Copy shared filters to each driver"
            : "Select laps independently"}
        </button>
        <button
          className="text-button"
          onClick={() => onChange({ ...value, paceActive: false, pace: {} })}
        >
          Reset pace selection
        </button>
      </div>
      {value.paceActive &&
        selected.map((driver) => {
          const laps = data.laps
            .filter((l) => l.driver === driver)
            .sort((a, b) => a.number - b.number);
          const f = value.pace[driver];
          if (!f)
            return (
              <button
                className="text-button"
                key={driver}
                onClick={() => update(driver, { ...defaults, excluded: [] })}
              >
                Configure {driver}
              </button>
            );
          const included = advancedPaceLaps(laps, [driver], { [driver]: f });
          const max = Math.max(1, ...laps.map((l) => l.number));
          return (
            <fieldset className="advanced-row" key={driver}>
              <legend>
                {driver} · {included.length} included /{" "}
                {laps.length - included.length} excluded
              </legend>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={f.clean}
                  onChange={(e) =>
                    update(driver, { ...f, clean: e.target.checked })
                  }
                />
                Clean laps
              </label>
              <label>
                Compound
                <select
                  value={f.compound}
                  onChange={(e) =>
                    update(driver, { ...f, compound: e.target.value })
                  }
                >
                  <option value="ALL">All compounds</option>
                  {[...new Set(laps.map((l) => l.compound))].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                Stint
                <select
                  value={f.stint}
                  onChange={(e) =>
                    update(driver, { ...f, stint: e.target.value })
                  }
                >
                  <option value="ALL">All stints</option>
                  {[...new Set(laps.map((l) => l.stint))].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                From lap
                <input
                  type="number"
                  min={1}
                  max={max}
                  value={f.from}
                  onChange={(e) => {
                    const from = Math.max(
                      1,
                      Math.min(max, Number(e.target.value) || 1),
                    );
                    update(driver, { ...f, from, to: Math.max(from, f.to) });
                  }}
                />
              </label>
              <label>
                To lap
                <input
                  type="number"
                  min={f.from}
                  max={max}
                  value={Math.min(f.to, max)}
                  onChange={(e) =>
                    update(driver, {
                      ...f,
                      to: Math.max(
                        f.from,
                        Math.min(max, Number(e.target.value) || f.from),
                      ),
                    })
                  }
                />
              </label>
              <details className="lap-list">
                <summary>Review laps and exclusions</summary>
                <div className="table-scroll">
                  <table className="ranking">
                    <thead>
                      <tr>
                        <th>Include</th>
                        <th>Lap</th>
                        <th>Time</th>
                        <th>Tyre</th>
                        <th>Status</th>
                        <th>Comparison</th>
                      </tr>
                    </thead>
                    <tbody>
                      {laps.map((l) => (
                        <tr key={l.number}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Include ${driver} lap ${l.number}`}
                              checked={!f.excluded.includes(l.number)}
                              onChange={(e) =>
                                update(driver, {
                                  ...f,
                                  excluded: e.target.checked
                                    ? f.excluded.filter((n) => n !== l.number)
                                    : [...f.excluded, l.number],
                                })
                              }
                            />
                          </td>
                          <td>{l.number}</td>
                          <td>{formatTime(l.time)}</td>
                          <td>
                            {l.compound} · age {l.tyre_age ?? "?"}
                          </td>
                          <td>
                            {included.includes(l) ? "Included" : "Excluded"}
                            {lapFlags(l) ? ` · ${lapFlags(l)}` : ""}
                          </td>
                          <td>
                            <button
                              className="text-button"
                              onClick={() => onCompare(l)}
                            >
                              Compare this lap
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </fieldset>
          );
        })}
      {value.paceActive && (
        <p className="filter-note">
          Each driver’s selection controls the pace charts. Unchecking a lap
          excludes it; checking it still requires it to match that driver’s
          filters.
        </p>
      )}
    </Disclosure>
  );
}
