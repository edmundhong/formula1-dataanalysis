"use client";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { Activity, ArrowUpRight, Info, Wind } from "lucide-react";
import {
  bestLaps,
  compoundColors,
  dominance,
  formatTime,
  median,
  paceLaps,
  selectedTraces,
} from "@/lib/analysis";
import type { Analysis, Driver, Lap, Session, Trace } from "@/lib/types";
import { cornerMarkers } from "@/lib/corners";
const Chart = dynamic(() => import("./chart"), {
  ssr: false,
  loading: () => <div className="chart-skeleton" />,
});
const line = (
  name: string,
  data: (number | null)[][],
  color: string,
  index = 0,
) => ({
  name,
  type: "line",
  data,
  showSymbol: false,
  connectNulls: false,
  lineStyle: { width: 2, type: index % 2 ? "dashed" : "solid" },
  itemStyle: { color },
  emphasis: { focus: "series" },
});
const zoom = [{ type: "inside", filterMode: "none" }];
const color = (drivers: Driver[], code: string) =>
  drivers.find((d) => d.code === code)?.color || "#8c93a3";
export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <Activity size={25} />
      <p>{children}</p>
    </div>
  );
}
export function Panel({
  title,
  eyebrow,
  aside,
  children,
  className = "",
}: {
  title: string;
  eyebrow?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h2>{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function TrackMap({ traces, drivers, corners }: { traces: Trace[]; drivers: Driver[]; corners?: Analysis["corners"] }) {
  const sections = useMemo(() => dominance(traces), [traces]);
  const [hover, setHover] = useState<number | null>(null);
  const ref = traces[0];
  if (!ref || !sections.length)
    return (
      <Empty>
        Select at least two drivers with reliable telemetry to compare sections.
      </Empty>
    );
  const xs = ref.x.filter((v): v is number => v != null),
    ys = ref.y.filter((v): v is number => v != null);
  if (!xs.length || !ys.length)
    return <Empty>Circuit coordinates are unavailable.</Empty>;
  const xmin = Math.min(...xs),
    xmax = Math.max(...xs),
    ymin = Math.min(...ys),
    ymax = Math.max(...ys);
  const scale = Math.min(600 / (xmax - xmin || 1), 290 / (ymax - ymin || 1));
  const x = (v: number) =>
    50 + (v - xmin) * scale + (600 - (xmax - xmin) * scale) / 2;
  const y = (v: number) => 330 - (v - ymin) * scale;
  const markers = cornerMarkers(corners, x, y);
  const current = hover == null ? null : sections[hover];
  const stroke = (driver: string) => {
    const index = traces.findIndex((t) => t.driver === driver);
    return index > 0 ? `url(#driver-pattern-${index})` : color(drivers, driver);
  };
  const points = (start: number, end: number) =>
    ref.x
      .slice(start, end + 1)
      .map((v, j) =>
        v != null && ref.y[start + j] != null
          ? `${x(v)},${y(ref.y[start + j]!)}`
          : null,
      )
      .filter(Boolean)
      .join(" ");
  return (
    <>
      <div className="track-wrap">
        <svg
          viewBox="0 0 700 380"
          role="img"
          aria-label={`Circuit map coloured by fastest driver through each section${markers.length ? ", with numbered corners" : ""}`}
        >
          <defs>
            {traces.map((t, i) => (
              <pattern
                key={t.driver}
                id={`driver-pattern-${i}`}
                width={6 + i * 3}
                height={6 + i * 3}
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="20" height="20" fill={color(drivers, t.driver)} />
                <rect width="2" height="20" fill="var(--panel)" />
              </pattern>
            ))}
          </defs>
          {sections.map((s) => (
            <polyline
              key={s.index}
              points={points(s.start, s.end)}
              fill="none"
              stroke={
                s.winner ? stroke(s.winner) : s.tied ? "#acb3bf" : "#4e5563"
              }
              strokeWidth={hover === s.index ? 11 : 7}
              strokeLinecap="round"
              strokeLinejoin="round"
              tabIndex={0}
              onFocus={() => setHover(s.index)}
              onBlur={() => setHover(null)}
              onMouseEnter={() => setHover(s.index)}
              onMouseLeave={() => setHover(null)}
              aria-label={`Section ${s.index + 1}: ${s.winner || (s.tied ? "approximately tied" : "unavailable")}`}
            >
              <title>{`Section ${s.index + 1}: ${s.times.map((t) => `${t.driver} ${t.seconds.toFixed(3)}s`).join(", ")}`}</title>
            </polyline>
          ))}
          {ref.x[0] != null && ref.y[0] != null && (
            <g>
              <circle
                cx={x(ref.x[0])}
                cy={y(ref.y[0])}
                r="7"
                fill="var(--text)"
                stroke="var(--panel)"
                strokeWidth="3"
              />
              <text
                x={x(ref.x[0]) + 13}
                y={y(ref.y[0]) - 13}
                fill="var(--muted)"
                fontSize="11"
              >
                START / FINISH
              </text>
            </g>
          )}
          <g pointerEvents="none">
            {markers.map(marker => (
              <g key={marker.label} role="img" aria-label={`Turn ${marker.label}`}>
                <title>{`Turn ${marker.label}`}</title>
                <line x1={marker.anchorX} y1={marker.anchorY} x2={marker.x} y2={marker.y} stroke="#8993a3" strokeWidth="1" />
                <circle cx={marker.x} cy={marker.y} r={marker.radius} fill="#080f1e" stroke="#8993a3" strokeWidth="1" />
                <text x={marker.x} y={marker.y} textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize="11" fontWeight="600">{marker.label}</text>
              </g>
            ))}
          </g>
        </svg>
        <div className="track-caption">
          {current ? (
            <>
              <strong>Section {current.index + 1}</strong>
              <span>
                {current.times.length
                  ? current.times
                      .map((t) => `${t.driver} ${t.seconds.toFixed(3)}s`)
                      .join(" · ")
                  : "Insufficient telemetry"}
              </span>
            </>
          ) : (
            <>
              <strong>Where the time is made</strong>
              <span>Hover or focus a section to compare traversal times</span>
            </>
          )}
        </div>
      </div>
      <div className="dominance-legend">
        {traces.map((t) => {
          const percentage = sections
            .filter((s) => s.winner === t.driver)
            .reduce((n, s) => n + ((s.end - s.start) / 999) * 100, 0);
          return (
            <div key={t.driver}>
              <span
                className="driver-dot"
                style={{ background: color(drivers, t.driver) }}
              />
              <strong>{t.driver}</strong>
              <span className="mono">{percentage.toFixed(1)}%</span>
            </div>
          );
        })}
        <div>
          <span className="driver-dot" style={{ background: "#acb3bf" }} />
          <span>Tied / unavailable</span>
          <span className="mono">
            {sections
              .filter((s) => !s.winner)
              .reduce((n, s) => n + ((s.end - s.start) / 999) * 100, 0)
              .toFixed(1)}
            %
          </span>
        </div>
      </div>
      <p className="footnote">
        <Info size={13} />
        FastF1 team colours:{" "}
        {traces
          .map((t, i) => `${t.driver} ${i ? "striped" : "solid"}`)
          .join(" · ")}
        . Estimated section times; differences below 0.01s are tied.
      </p>
    </>
  );
}

export function BestLapPanels({
  data,
  selected,
  phase,
  theme,
}: {
  data: Analysis;
  selected: string[];
  phase: string;
  theme: string;
}) {
  const best = useMemo(() => bestLaps(data.laps, phase), [data, phase]);
  const traces = useMemo(
    () => selectedTraces(data, selected, phase),
    [data, selected, phase],
  );
  const reference = traces[0];
  const [channel, setChannel] = useState<
    "speed" | "throttle" | "brake" | "gear" | "rpm"
  >("speed");
  const units = {
    speed: "km/h",
    throttle: "%",
    brake: "0 / 1",
    gear: "Gear",
    rpm: "RPM",
  };
  const telemetry = useMemo(
    () => ({
      dataZoom: zoom,
      xAxis: { name: "Lap distance (m)", nameLocation: "middle", nameGap: 29 },
      yAxis: { name: units[channel] },
      series: traces.map((t, i) =>
        line(
          t.driver,
          t.distance.map((d, j) => [
            reference?.distance[j] ?? d,
            t[channel][j],
          ]),
          color(data.drivers, t.driver),
          i,
        ),
      ),
    }),
    [traces, reference, channel, data.drivers],
  );
  const delta = useMemo(
    () => ({
      dataZoom: zoom,
      xAxis: { name: "Lap distance (m)", nameLocation: "middle", nameGap: 29 },
      yAxis: { name: "Gap (s)" },
      series: traces
        .filter((t) => t.reliable && reference?.reliable)
        .map((t, i) =>
          line(
            t.driver,
            t.distance.map((d, j) => [
              reference.distance[j] ?? d,
              t.time[j] != null && reference.time[j] != null
                ? t.time[j]! - reference.time[j]!
                : null,
            ]),
            color(data.drivers, t.driver),
            i,
          ),
        ),
    }),
    [traces, reference, data.drivers],
  );
  const sectorOption = useMemo(
    () => ({
      legend: { top: 0 },
      xAxis: { type: "category", data: ["Sector 1", "Sector 2", "Sector 3"] },
      yAxis: { name: "Seconds" },
      series: selected.map((d) => ({
        name: d,
        type: "bar",
        data: [0, 1, 2].map((s) => {
          const vals = data.laps
            .filter(
              (l) =>
                l.driver === d &&
                !l.deleted &&
                (phase === "ALL" || l.phase === phase),
            )
            .map((l) => l.sectors[s])
            .filter((n): n is number => n != null);
          return vals.length ? Math.min(...vals) : null;
        }),
        itemStyle: {
          color: color(data.drivers, d),
          borderRadius: [3, 3, 0, 0],
        },
      })),
    }),
    [data, selected, phase],
  );
  const teamSpeeds = useMemo(() => {
    const teams = new Map<
      string,
      { driver: string; max: number; min: number; time: number }
    >();
    for (const t of data.traces.filter((t) => t.phase === phase)) {
      const driver = data.drivers.find((d) => d.code === t.driver);
      const speeds = t.speed.filter((v): v is number => v != null);
      if (
        driver &&
        speeds.length &&
        (!teams.has(driver.team) || t.lap_time < teams.get(driver.team)!.time)
      )
        teams.set(driver.team, {
          driver: t.driver,
          max: Math.max(...speeds),
          min: Math.min(...speeds),
          time: t.lap_time,
        });
    }
    return [...teams].sort((a, b) => b[1].max - a[1].max);
  }, [data, phase]);
  return (
    <>
      <div className="analysis-grid">
        <Panel
          title="Fastest laps"
          eyebrow="THE BENCHMARK"
          aside={<span className="pill">{best.length} drivers</span>}
        >
          <div className="ranking-scroll">
            <table className="ranking">
              <thead>
                <tr>
                  <th>Pos</th>
                  <th>Driver</th>
                  <th>Lap time</th>
                  <th>Gap</th>
                </tr>
              </thead>
              <tbody>
                {best.map((lap, i) => {
                  const driver = data.drivers.find(
                    (d) => d.code === lap.driver,
                  );
                  return (
                    <tr
                      key={lap.driver}
                      className={
                        selected.includes(lap.driver) ? "selected-row" : ""
                      }
                    >
                      <td className="position mono">
                        {String(i + 1).padStart(2, "0")}
                      </td>
                      <td>
                        <span className="driver-label">
                          <i style={{ background: driver?.color }} />
                          <span>
                            <strong>{lap.driver}</strong>
                            <small>{driver?.team}</small>
                          </span>
                        </span>
                      </td>
                      <td className="mono">{formatTime(lap.time)}</td>
                      <td className="mono gap">
                        {i === 0 ? (
                          <span className="fastest-tag">FASTEST</span>
                        ) : (
                          `+${(lap.time! - best[0].time!).toFixed(3)}`
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!best.length && (
              <Empty>No valid timed laps for this segment.</Empty>
            )}
          </div>
        </Panel>
        <Panel
          title="Track dominance"
          eyebrow="A LAP, SECTION BY SECTION"
          aside={
            <span className="pill">
              50 sections <ArrowUpRight size={12} />
            </span>
          }
        >
          <TrackMap traces={traces} drivers={data.drivers} corners={data.corners} />
        </Panel>
      </div>
      <Panel
        title="Telemetry comparison"
        eyebrow="READ BETWEEN THE CORNERS"
        aside={
          <div className="mini-tabs" aria-label="Telemetry channel">
            {(["speed", "throttle", "brake", "gear", "rpm"] as const).map(
              (c) => (
                <button
                  key={c}
                  aria-pressed={channel === c}
                  className={channel === c ? "active" : ""}
                  onClick={() => setChannel(c)}
                >
                  {c.toUpperCase()}
                </button>
              ),
            )}
          </div>
        }
      >
        {traces.length ? (
          <>
            <Chart
              option={telemetry}
              theme={theme}
              group="telemetry"
              label={`${channel} versus distance for selected drivers`}
            />
            <div className="subchart-title">
              Cumulative delta{" "}
              <span>
                Relative to {reference?.driver} · positive means behind
              </span>
            </div>
            {reference?.reliable ? (
              <Chart
                option={delta}
                theme={theme}
                height={200}
                group="telemetry"
                label="Estimated cumulative lap-time difference"
              />
            ) : (
              <Empty>
                Time-delta comparison is unavailable because the timing quality
                check failed.
              </Empty>
            )}
          </>
        ) : (
          <Empty>Telemetry is not available for the selected laps yet.</Empty>
        )}
        {traces.length < selected.length && (
          <p className="footnote">
            Some selected drivers have no telemetry in this segment.
          </p>
        )}
      </Panel>
      <div className="equal-grid">
        <Panel title="Best sectors" eyebrow="ONE SECTOR AT A TIME">
          <Chart
            option={sectorOption}
            theme={theme}
            label="Best sector times for selected drivers"
          />
          <p className="footnote">
            Each driver’s best valid sector; these can come from different laps.
          </p>
        </Panel>
        <Panel title="Team speed range" eyebrow="ON EACH TEAM’S FASTEST LAP">
          <div className="speed-table">
            <div className="speed-head">
              <span>Team</span>
              <span>Min / Max · km/h</span>
            </div>
            {teamSpeeds.map(([team, s]) => (
              <div className="speed-row" key={team}>
                <span>
                  <i
                    className="driver-dot"
                    style={{ background: color(data.drivers, s.driver) }}
                  />
                  {team}
                </span>
                <strong className="mono">
                  <span className="muted">{s.min.toFixed(0)}</span> /{" "}
                  {s.max.toFixed(0)}
                </strong>
                <div
                  className="speed-bar"
                  style={{
                    width: `${(s.max / 380) * 100}%`,
                    background: color(data.drivers, s.driver),
                  }}
                />
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}

function percentile(values: number[], p: number) {
  const a = [...values].sort((a, b) => a - b);
  const n = (a.length - 1) * p;
  return a[Math.floor(n)] + (a[Math.ceil(n)] - a[Math.floor(n)]) * (n % 1);
}
export interface PaceOptions {
  clean: boolean;
  compound: string;
  stint: string;
  from: number;
  to: number;
}
export function PacePanels({
  data,
  session,
  selected,
  theme,
  filters,
  onFilters,
}: {
  data: Analysis;
  session: Session;
  selected: string[];
  theme: string;
  filters: PaceOptions;
  onFilters: (filters: PaceOptions) => void;
}) {
  const { clean, compound, stint, from, to } = filters;
  const setClean = (clean: boolean) => onFilters({ ...filters, clean });
  const setCompound = (compound: string) => onFilters({ ...filters, compound });
  const setStint = (stint: string) => onFilters({ ...filters, stint });
  const setFrom = (from: number) => onFilters({ ...filters, from });
  const setTo = (to: number) => onFilters({ ...filters, to });
  const maxLap = Math.max(1, ...data.laps.map((l) => l.number));
  const filtered = useMemo(
    () =>
      paceLaps(data.laps, {
        drivers: selected,
        compound,
        stint,
        from,
        to,
        clean,
      }),
    [data, selected, compound, stint, from, to, clean],
  );
  const eligible = paceLaps(data.laps, {
    drivers: selected,
    compound,
    stint,
    from,
    to,
    clean: false,
  });
  const seriesByDriver = (field: "time" | "position", source: Lap[]) =>
    selected.map((d, i) =>
      line(
        d,
        source
          .filter((l) => l.driver === d)
          .sort((a, b) => a.number - b.number)
          .map((l) => [l.number, l[field]]),
        color(data.drivers, d),
        i,
      ),
    );
  const lapOption = {
    dataZoom: zoom,
    xAxis: { name: "Lap", min: from, max: Math.min(to, maxLap) },
    yAxis: { name: "Lap time (s)" },
    series: seriesByDriver("time", filtered),
  };
  const distributions = selected
    .map((d) => ({
      driver: d,
      values: filtered.filter((l) => l.driver === d).map((l) => l.time!),
    }))
    .filter((g) => g.values.length);
  const boxOption = {
    xAxis: { type: "category", data: distributions.map((g) => g.driver) },
    yAxis: { name: "Seconds" },
    series: [
      {
        type: "boxplot",
        data: distributions.map((g) => ({
          value: [0, 0.25, 0.5, 0.75, 1].map((p) => percentile(g.values, p)),
          itemStyle: {
            color: color(data.drivers, g.driver) + "44",
            borderColor: color(data.drivers, g.driver),
          },
        })),
      },
    ],
    legend: { show: false },
  };
  const sectorOption = {
    xAxis: { type: "category", data: ["Sector 1", "Sector 2", "Sector 3"] },
    yAxis: { name: "Seconds" },
    series: selected.map((d) => ({
      name: d,
      type: "bar",
      itemStyle: { color: color(data.drivers, d) },
      data: [0, 1, 2].map((i) =>
        median(
          filtered
            .filter((l) => l.driver === d)
            .map((l) => l.sectors[i])
            .filter((v): v is number => v != null),
        ),
      ),
    })),
  };
  const tyreGroups = new Map<string, Lap[]>();
  for (const lap of filtered) {
    const key = `${lap.driver} · ${lap.compound} · stint ${lap.stint}`;
    tyreGroups.set(key, [...(tyreGroups.get(key) || []), lap]);
  }
  const tyreOption = {
    dataZoom: zoom,
    legend: { type: "scroll", top: 0 },
    xAxis: { name: "Tyre age (laps)" },
    yAxis: { name: "Lap time (s)" },
    series: [...tyreGroups].map(([name, laps], i) =>
      line(
        name,
        laps
          .filter((l) => l.tyre_age != null)
          .sort((a, b) => a.tyre_age! - b.tyre_age!)
          .map((l) => [l.tyre_age, l.time]),
        color(data.drivers, laps[0].driver),
        i,
      ),
    ),
  };
  const race = ["R", "S"].includes(session.code);
  return (
    <>
      <div className="pace-filters">
        <label className="check-label">
          <input
            type="checkbox"
            checked={clean}
            onChange={(e) => setClean(e.target.checked)}
          />
          Clean pace laps
        </label>
        <label>
          Compound
          <select
            value={compound}
            onChange={(e) => setCompound(e.target.value)}
          >
            <option value="ALL">All compounds</option>
            {[...new Set(data.laps.map((l) => l.compound))].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Stint
          <select value={stint} onChange={(e) => setStint(e.target.value)}>
            <option value="ALL">All stints</option>
            {[...new Set(data.laps.map((l) => l.stint))]
              .sort((a, b) => a - b)
              .map((s) => (
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
            max={maxLap}
            value={from}
            onChange={(e) => setFrom(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <label>
          To lap
          <input
            type="number"
            min={1}
            max={maxLap}
            value={Math.min(to, maxLap)}
            onChange={(e) => setTo(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <span className="filter-count mono">
          {filtered.length} laps included
          <br />
          <small>{eligible.length - filtered.length} excluded</small>
        </span>
      </div>
      <p className="filter-note">
        {clean
          ? "Valid, accurate green-flag laps. First laps, pit-in/out laps and times above 107% of each driver’s eligible stint median are excluded."
          : "All timed laps, including deleted laps, pit laps and disrupted running."}
      </p>
      {!filtered.length ? (
        <Empty>
          No laps match these filters. Try another compound, stint, or lap
          range.
        </Empty>
      ) : (
        <>
          <Panel title="Lap by lap" eyebrow="THE SHAPE OF A SESSION">
            <Chart
              option={lapOption}
              theme={theme}
              height={330}
              label="Selected driver lap times across the session"
            />
          </Panel>
          <div className="equal-grid">
            <Panel title="Pace distribution" eyebrow="CONSISTENCY COUNTS">
              <Chart
                option={boxOption}
                theme={theme}
                label="Lap time minimum, quartiles, median and maximum"
              />
              <p className="footnote">
                Whiskers show min/max; box shows quartiles and median.{" "}
                {distributions
                  .map((g) => `${g.driver}: ${g.values.length} laps`)
                  .join(" · ")}
              </p>
            </Panel>
            <Panel title="Median sector pace" eyebrow="SECTOR BY SECTOR">
              <Chart
                option={sectorOption}
                theme={theme}
                label="Median sector times from included laps"
              />
            </Panel>
          </div>
          <Panel title="Tyre age & pace" eyebrow="OBSERVED STINT TRENDS">
            <Chart
              option={tyreOption}
              theme={theme}
              label="Lap time against tyre age, separated by driver, stint and compound"
            />
            <p className="footnote">
              <Info size={13} />
              These are observed pace trends. Fuel load, traffic, weather and
              track evolution are not corrected.
            </p>
          </Panel>
        </>
      )}
      <Panel
        title="Tyre strategy"
        eyebrow="EVERY STINT TELLS A STORY"
        aside={<span className="pill">Full session</span>}
      >
        <div className="stint-key">
          {Object.entries(compoundColors)
            .filter(([c]) => data.laps.some((l) => l.compound === c))
            .map(([c, v]) => (
              <span key={c}>
                <i style={{ background: v }} />
                {c}
              </span>
            ))}
          <span>Striped = used tyres</span>
        </div>
        <div className="stints">
          {selected.map((d) => {
            const laps = data.laps.filter((l) => l.driver === d);
            const stints = [...new Set(laps.map((l) => l.stint))];
            return (
              <div className="stint-row" key={d}>
                <strong>{d}</strong>
                <div className="stint-track">
                  {stints.map((s) => {
                    const run = laps.filter((l) => l.stint === s),
                      min = Math.min(...run.map((l) => l.number)),
                      max = Math.max(...run.map((l) => l.number));
                    return (
                      <div
                        key={s}
                        className={`stint ${run[0].fresh ? "" : "used"}`}
                        style={{
                          left: `${((min - 1) / maxLap) * 100}%`,
                          width: `${((max - min + 1) / maxLap) * 100}%`,
                          backgroundColor:
                            compoundColors[run[0].compound] || "#888",
                        }}
                        title={`${d}: ${run[0].compound}, laps ${min}–${max}, ${run[0].fresh ? "fresh" : "used"}`}
                      >
                        <span>{max - min + 1}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="stint-axis">
            <span>1</span>
            <span>Lap {maxLap}</span>
          </div>
        </div>
      </Panel>
      {race && (
        <div className="equal-grid">
          <Panel
            title="Position changes"
            eyebrow="THROUGH THE FIELD"
            aside={<span className="pill">Full session</span>}
          >
            <Chart
              option={{
                dataZoom: zoom,
                xAxis: { name: "Lap" },
                yAxis: {
                  name: "Position",
                  inverse: true,
                  min: 1,
                  max: data.drivers.length,
                  minInterval: 1,
                },
                series: seriesByDriver("position", data.laps),
              }}
              theme={theme}
              label="Race positions by lap"
            />
          </Panel>
          <Panel
            title="Pit-lane time"
            eyebrow="ENTRY TO EXIT"
            aside={<span className="pill">Full session</span>}
          >
            <div className="table-scroll">
              <table className="ranking">
                <thead>
                  <tr>
                    <th>Driver</th>
                    <th>Lap</th>
                    <th>Time in lane</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pit_stops
                    .filter((p) => selected.includes(p.driver))
                    .map((p, i) => (
                      <tr key={i}>
                        <td>
                          <span
                            className="driver-dot"
                            style={{
                              background: color(data.drivers, p.driver),
                            }}
                          />
                          {p.driver}
                        </td>
                        <td>{p.lap}</td>
                        <td className="mono">{p.duration.toFixed(3)}s</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {!data.pit_stops.some((p) => selected.includes(p.driver)) && (
              <Empty>No matched pit stops for these drivers.</Empty>
            )}
            <p className="footnote">
              Includes transit through the pit lane, not just stationary
              service. Garage visits above five minutes are excluded.
            </p>
          </Panel>
        </div>
      )}
    </>
  );
}

export function WeatherPanel({
  data,
  theme,
}: {
  data: Analysis;
  theme: string;
}) {
  const rain = data.weather.some((w) => w.rain);
  const temps = useMemo(
    () => ({
      xAxis: { name: "Session (min)" },
      yAxis: { name: "°C" },
      series: [
        line(
          "Track",
          data.weather.map((w) => [w.minute, w.track]),
          "#f07853",
        ),
        line(
          "Air",
          data.weather.map((w) => [w.minute, w.air]),
          "#60a8ed",
          1,
        ),
      ],
    }),
    [data],
  );
  if (!data.weather.length) return null;
  return (
    <Panel
      title="Track conditions"
      eyebrow="THE OTHER VARIABLE"
      aside={
        <span className="pill">
          {rain ? "Rain recorded" : "No rain recorded"}
        </span>
      }
    >
      <div className="weather-grid">
        <Chart
          option={temps}
          theme={theme}
          height={235}
          label="Track and air temperatures over the session"
        />
        <div className="weather-readings">
          <div>
            <span>Median humidity</span>
            <strong className="mono">
              {median(
                data.weather
                  .map((w) => w.humidity)
                  .filter((v): v is number => v != null),
              )?.toFixed(0) ?? "—"}
              <small>%</small>
            </strong>
          </div>
          <div>
            <span>Median pressure</span>
            <strong className="mono">
              {median(
                data.weather
                  .map((w) => w.pressure)
                  .filter((v): v is number => v != null),
              )?.toFixed(0) ?? "—"}
              <small>mbar</small>
            </strong>
          </div>
          <div>
            <span>
              <Wind size={14} /> Median wind speed
            </span>
            <strong className="mono">
              {median(
                data.weather
                  .map((w) => w.wind_speed)
                  .filter((v): v is number => v != null),
              )?.toFixed(1) ?? "—"}
              <small>m/s</small>
            </strong>
          </div>
        </div>
      </div>
    </Panel>
  );
}
