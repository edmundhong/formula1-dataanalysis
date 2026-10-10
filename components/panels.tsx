"use client";
import dynamic from "next/dynamic";
import type { CustomSeriesRenderItem } from "echarts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
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
import type {
  AdvancedSelection,
  Analysis,
  Driver,
  Lap,
  Session,
  Trace,
} from "@/lib/types";
import { advancedPaceLaps } from "@/lib/advanced";
import { useLapTelemetry } from "./use-lap-telemetry";
import { cornerMarkers } from "@/lib/corners";
import { trackPosition } from "@/lib/track-position";
import { SectorPaceMap } from "./sector-pace-map";
const comparisonColors = ["#479eff", "#f59e0b", "#c084fc", "#10b981"];
const comparisonColor = (index: number) => comparisonColors[index % comparisonColors.length];
const traceColor = (t: Trace, traces: Trace[]) => comparisonColor(t.comparison_id?.startsWith("slot-") ? Number(t.comparison_id.slice(5)) : traces.indexOf(t));
const traceId = (t: Trace) => t.comparison_id ?? t.driver;
const traceLabel = (t: Trace) => t.label ?? t.driver;
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
  lineStyle: {
    width: index % 4 === 3 ? 3 : 2,
    type: ["solid", "dashed", "dotted", "dashed"][index % 4],
  },
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

function TrackMap({
  traces,
  drivers,
  corners,
  distance,
  reference,
}: {
  traces: Trace[];
  drivers: Driver[];
  corners?: Analysis["corners"];
  distance: number | null;
  reference?: Trace;
}) {
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
  const position = trackPosition(ref, reference?.distance ?? ref.distance, distance);
  const activeSection = hover ?? (position
    ? sections.find((section) => position.index >= section.start && position.index <= section.end)?.index
    : null);
  const current = activeSection == null ? null : sections[activeSection];
  const stroke = (driver: string) => {
    const index = traces.findIndex((t) => traceId(t) === driver);
    return index > 0
      ? `url(#driver-pattern-${index})`
      : traces[index] ? traceColor(traces[index], traces) : "#8c93a3";
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
                key={traceId(t)}
                id={`driver-pattern-${i}`}
                width={6 + i * 3}
                height={6 + i * 3}
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="20" height="20" fill={traceColor(t, traces)} />
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
              strokeWidth={activeSection === s.index ? 11 : 7}
              strokeLinecap="round"
              strokeLinejoin="round"
              tabIndex={0}
              onFocus={() => setHover(s.index)}
              onBlur={() => setHover(null)}
              onMouseEnter={() => setHover(s.index)}
              onMouseLeave={() => setHover(null)}
              aria-label={`Section ${s.index + 1}: ${traces.find((t) => traceId(t) === s.winner)?.label || s.winner || (s.tied ? "approximately tied" : "unavailable")}`}
            >
              <title>{`Section ${s.index + 1}: ${s.times.map((t) => `${traces.find((trace) => traceId(trace) === t.driver)?.label || t.driver} ${t.seconds.toFixed(3)}s`).join(", ")}`}</title>
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
            {markers.map((marker) => (
              <g
                key={marker.label}
                role="img"
                aria-label={`Turn ${marker.label}`}
              >
                <title>{`Turn ${marker.label}`}</title>
                <line
                  x1={marker.anchorX}
                  y1={marker.anchorY}
                  x2={marker.x}
                  y2={marker.y}
                  stroke="#8993a3"
                  strokeWidth="1"
                />
                <circle
                  cx={marker.x}
                  cy={marker.y}
                  r={marker.radius}
                  fill="#080f1e"
                  stroke="#8993a3"
                  strokeWidth="1"
                />
                <text
                  x={marker.x}
                  y={marker.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#fff"
                  fontSize="11"
                  fontWeight="600"
                >
                  {marker.label}
                </text>
              </g>
            ))}
          </g>
          {position && (
            <g pointerEvents="none" aria-label={`Telemetry position: ${Math.round(distance!)} metres`}>
              <circle cx={x(position.x)} cy={y(position.y)} r="15" fill="#fff" fillOpacity="0.22" />
              <circle cx={x(position.x)} cy={y(position.y)} r="8" fill="#fff" stroke="#111827" strokeWidth="3" />
            </g>
          )}
        </svg>
        <div className="track-caption">
          {current ? (
            <>
              <strong>Section {current.index + 1}{position && ` · ${Math.round(distance!).toLocaleString()} m`}</strong>
              <span>
                {current.times.length
                  ? current.times
                      .map(
                        (t) =>
                          `${traces.find((trace) => traceId(trace) === t.driver)?.label || t.driver} ${t.seconds.toFixed(3)}s`,
                      )
                      .join(" · ")
                  : "Insufficient telemetry"}
              </span>
            </>
          ) : (
            <>
              <strong>Where the time is made</strong>
              <span>Hover telemetry to locate your position, or a track section to compare times</span>
            </>
          )}
        </div>
      </div>
      <div className="dominance-legend">
        {traces.map((t) => {
          const percentage = sections
            .filter((s) => s.winner === traceId(t))
            .reduce((n, s) => n + ((s.end - s.start) / 999) * 100, 0);
          return (
            <div key={traceId(t)}>
              <span
                className="driver-dot"
                style={{ background: traceColor(t, traces) }}
              />
              <strong>{traceLabel(t)}</strong>
              <span className="mono">{percentage.toFixed(0)}%</span>
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
              .toFixed(0)}
            %
          </span>
        </div>
      </div>
      <p className="footnote">
        <Info size={13} />
        Comparison colours:{" "}
        {traces
          .map((t, i) => `${traceLabel(t)} ${i ? "striped" : "solid"}`)
          .join(" · ")}
        . Estimated section times; differences below 0.01s are tied.
      </p>
    </>
  );
}

export function SessionSummary({ data, selected, phase, theme }: {
  data: Analysis; selected: string[]; phase: string; theme: string;
}) {
  const [view, setView] = useState("fastest");
  const summaryTabsRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const tabs = summaryTabsRef.current;
    if (!tabs) return;
    const updateHighlight = () => {
      const active = tabs.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      if (!active) return;
      const next = { x: active.offsetLeft, y: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight };
      setHighlight((previous) => previous && Object.keys(next).every((key) => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    updateHighlight();
    const observer = new ResizeObserver(updateHighlight);
    observer.observe(tabs);
    tabs.querySelectorAll("button").forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [view]);

  const best = useMemo(() => bestLaps(data.laps, phase), [data, phase]);
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
    <section className="session-summary" aria-label="Session overview">
      <div className="summary-heading">
        <span className="eyebrow">SESSION OVERVIEW</span>
        <p className="footnote">Lap choices and pace filters do not change session benchmarks. Fastest laps, best sectors and team speeds follow the session phase; best sectors follows the comparison drivers. Track conditions covers the full session.</p>
        <div ref={summaryTabsRef} className={`mini-tabs summary-pills${highlight ? " has-highlight" : ""}`} aria-label="Session summary views">
          {highlight && <span aria-hidden="true" className="summary-pill-highlight" style={{ transform: `translate(${highlight.x}px, ${highlight.y}px)`, width: highlight.width, height: highlight.height }} />}
          {[["fastest", "Fastest laps"], ["sectors", "Best sectors"], ["speed", "Team speed range"], ["weather", "Track conditions"]].map(([id, label]) => (
            <button key={id} type="button" aria-pressed={view === id} aria-controls="session-summary-content" className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
      </div>
      <div id="session-summary-content">
        {view === "fastest" && (        <Panel
          title="Fastest laps"
          eyebrow="SESSION SUMMARY · THE BENCHMARK"
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
)}
        {view === "sectors" && (        <Panel
          title="Best sectors"
          eyebrow="SESSION SUMMARY · THEORETICAL BEST"
        >
          <Chart
            option={sectorOption}
            theme={theme}
            label="Best sector times for selected drivers"
          />
          <p className="footnote">
            Each driver’s best valid sector; these can come from different laps.
          </p>
        </Panel>
)}
        {view === "speed" && (        <Panel title="Team speed range" eyebrow="ON EACH TEAM’S FASTEST LAP">
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
)}
        {view === "weather" && <WeatherPanel data={data} theme={theme} />}
      </div>
    </section>
  );
}

export function BestLapPanels({
  data,
  selected,
  phase,
  theme,
  session,
  advanced,
}: {
  data: Analysis;
  selected: string[];
  phase: string;
  theme: string;
  session: Session;
  advanced: AdvancedSelection;
}) {
  const lapTelemetry = useLapTelemetry(data, session, advanced.slots);
  const defaultTraces = useMemo(
    () => selectedTraces(data, selected, phase),
    [data, selected, phase],
  );
  const traces = useMemo(() => advanced.slots.length
    ? lapTelemetry.rows.flatMap((r) => (r.trace ? [r.trace] : []))
    : defaultTraces, [advanced.slots.length, lapTelemetry.rows, defaultTraces]);
  const reference = advanced.slots.length
    ? lapTelemetry.rows[advanced.reference]?.trace
    : traces[0];
  const [channel, setChannel] = useState<
    "speed" | "throttle" | "brake" | "gear" | "rpm"
  >("speed");
  const [distance, setDistance] = useState<number | null>(null);
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
          traceLabel(t),
          t.distance.map((d, j) => [
            reference?.distance[j] ?? d,
            t[channel][j],
          ]),
          traceColor(t, traces),
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
      tooltip: {
        valueFormatter: (value: unknown) =>
          typeof value === "number" ? value.toFixed(3) : "—",
      },
      series: traces
        .filter((t) => t.reliable && reference?.reliable)
        .map((t, i) =>
          line(
            traceLabel(t),
            t.distance.map((d, j) => [
              reference!.distance[j] ?? d,
              t.time[j] != null && reference!.time[j] != null
                ? t.time[j]! - reference!.time[j]!
                : null,
            ]),
            traceColor(t, traces),
            i,
          ),
        ),
    }),
    [traces, reference, data.drivers],
  );
  return (
    <>
      <div>
        <Panel
          title="Track dominance"
          eyebrow="A LAP, SECTION BY SECTION"
          aside={
            <span className="pill">
              50 sections <ArrowUpRight size={12} />
            </span>
          }
        >
          {advanced.slots.length && traces.length !== advanced.slots.length ? (
            <Empty>
              Track dominance needs reliable telemetry for every selected lap.
            </Empty>
          ) : (
            <TrackMap
              traces={traces}
              drivers={data.drivers}
              corners={data.corners}
              distance={distance}
              reference={reference}
            />
          )}
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
        {!!advanced.slots.length && (
          <div className="telemetry-status" aria-live="polite">
            {lapTelemetry.rows.map((r, i) => (
              <p key={i}>
                Comparison {i + 1}:{" "}
                {r.lap ? `${r.lap.driver} · Lap ${r.lap.number}` : "No lap"} ·{" "}
                {r.status}
              </p>
            ))}
            {lapTelemetry.failed && (
              <button className="text-button" onClick={lapTelemetry.retry}>
                Retry telemetry
              </button>
            )}
          </div>
        )}
        {traces.length ? (
          <>
            <Chart
              option={telemetry}
              theme={theme}
              group="telemetry"
              onDistanceHover={setDistance}
              label={`${channel} versus distance for selected drivers`}
            />
            <div className="subchart-title">
              Cumulative delta{" "}
              <span>
                Relative to{" "}
                {reference ? traceLabel(reference) : "unavailable reference"} ·
                positive means behind
              </span>
            </div>
            {reference?.reliable ? (
              <Chart
                option={delta}
                theme={theme}
                height={200}
                group="telemetry"
                onDistanceHover={setDistance}
                label="Estimated cumulative lap-time difference"
              />
            ) : (
              <Empty>
                Time-delta comparison needs available, reliable telemetry for
                the chosen reference lap.
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
      {!!advanced.slots.length && (
        <Panel title="Selected lap sectors" eyebrow="ACTUAL COMPARISON LAPS">
          <Chart
            option={{
              legend: { top: 0 },
              xAxis: {
                type: "category",
                data: ["Sector 1", "Sector 2", "Sector 3"],
              },
              yAxis: { name: "Seconds" },
              series: lapTelemetry.rows.map((r, i) => ({
                name: r.lap
                  ? `${r.lap.driver} · Lap ${r.lap.number}`
                  : `Comparison ${i + 1} · unavailable`,
                type: "bar",
                data: r.lap?.sectors || [null, null, null],
                itemStyle: {
                  color: comparisonColor(i),
                  decal:
                    i % 2
                      ? {
                          symbol: "rect",
                          dashArrayX: [1, 0],
                          dashArrayY: [2, 3],
                        }
                      : undefined,
                },
              })),
            }}
            theme={theme}
            label="Actual sector times from selected laps"
          />
          <p className="footnote">
            Each bar uses the selected lap’s recorded sector time.
          </p>
        </Panel>
      )}
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
  advanced,
}: {
  data: Analysis;
  session: Session;
  selected: string[];
  theme: string;
  filters: PaceOptions;
  onFilters: (filters: PaceOptions) => void;
  advanced: AdvancedSelection;
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
      advanced.paceActive
        ? advancedPaceLaps(data.laps, selected, advanced.pace)
        : paceLaps(data.laps, {
            drivers: selected,
            compound,
            stint,
            from,
            to,
            clean,
          }),
    [data, selected, compound, stint, from, to, clean, advanced],
  );
  const eligible = advanced.paceActive
    ? data.laps.filter((l) => selected.includes(l.driver))
    : paceLaps(data.laps, {
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
    xAxis: {
      name: "Lap",
      min: advanced.paceActive ? undefined : from,
      max: advanced.paceActive ? undefined : Math.min(to, maxLap),
    },
    yAxis: { name: "Lap time (s)" },
    series: seriesByDriver("time", filtered),
  };
  const distributions = selected
    .map((d) => ({
      driver: d,
      laps: filtered.filter((l) => l.driver === d),
      values: filtered.filter((l) => l.driver === d).map((l) => l.time!),
    }))
    .filter((g) => g.values.length);
  const violinOption = {
    aria: { decal: { show: false } },
    tooltip: { trigger: "item" },
    xAxis: {
      type: "category",
      data: distributions.map((g) => g.driver),
      axisLabel: { interval: 0 },
    },
    yAxis: { name: "Seconds" },
    series: [
      ...distributions.map((g, index) => {
        const min = Math.min(...g.values);
        const max = Math.max(...g.values);
        const mid = percentile(g.values, 0.5);
        // Gaussian kernel density, clipped to the observed lap-time range.
        const mean = g.values.reduce((sum, v) => sum + v, 0) / g.values.length;
        const deviation = Math.sqrt(g.values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / g.values.length);
        const bandwidth = Math.max(0.015, 1.06 * deviation * g.values.length ** -0.2);
        const densityAt = (value: number) => g.values.reduce((sum, v) => sum + Math.exp(-0.5 * ((value - v) / bandwidth) ** 2), 0);
        const samples = Array.from({ length: 65 }, (_, i) => min + (max - min) * i / 64);
        const peak = Math.max(...samples.map(densityAt));
        const renderItem: CustomSeriesRenderItem = (_params, api) => {
          const center = api.coord([index, mid]);
          const halfWidth = Math.min(42, Math.abs(api.coord([index + 1, mid])[0] - center[0]) * 0.34);
          const side = (sign: number) => samples.map((v) => [center[0] + sign * halfWidth * densityAt(v) / peak, api.coord([index, v])[1]]);
          return {
            type: "group",
            children: [
              ...(min < max ? [{
                type: "polygon" as const,
                shape: { points: [...side(-1), ...side(1).reverse()] },
                style: { fill: color(data.drivers, g.driver) + "33", stroke: color(data.drivers, g.driver), lineWidth: 1.5 },
              }] : []),
              {
                type: "line",
                shape: { x1: center[0] - halfWidth, x2: center[0] + halfWidth, y1: center[1], y2: center[1] },
                style: { stroke: color(data.drivers, g.driver), lineWidth: 2 },
              },
            ],
          };
        };
        return {
          type: "custom",
          renderItem,
          silent: true,
          data: [[index, min, max]],
          encode: { x: 0, y: [1, 2] },
        };
      }),
      ...distributions.map((g, index) => ({
        type: "scatter",
        symbolSize: 6,
        z: 3,
        tooltip: {
          formatter: (params: { dataIndex: number }) => {
            const lap = g.laps[params.dataIndex];
            return `${g.driver} · Lap ${lap.number}\n${lap.compound} · ${lap.time!.toFixed(3)} s`;
          },
          renderMode: "richText",
        },
        data: g.laps.map((lap, lapIndex) => ({
          value: [index, lap.time],
          symbolOffset: [((lapIndex * 0.61803398875) % 1 - 0.5) * 18, 0],
          itemStyle: {
            color: compoundColors[lap.compound] || compoundColors.UNKNOWN,
            borderColor: theme === "dark" ? "#171c23" : "#fff",
            borderWidth: 0.7,
            opacity: 0.9,
          },
        })),
      })),
    ],
    legend: { show: false },
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
      <fieldset
        className="pace-filters"
        disabled={advanced.paceActive}
        aria-label="Shared pace filters"
      >
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
      </fieldset>
      <p className="filter-note">
        {advanced.paceActive
          ? "Independent driver selections are active. Reset advanced pace selection to use shared filters."
          : clean
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
                option={violinOption}
                theme={theme}
                label="Lap time violin distributions with tyre-coloured lap dots and driver medians below"
              />
              <p className="footnote">
                Width shows lap-time density; dots show laps coloured by tyre compound. Horizontal lines show medians.
              </p>
              <div className="pace-compounds">
                {[...new Set(filtered.map((lap) => lap.compound))].map((compound) => (
                  <span key={compound}>
                    <i style={{ background: compoundColors[compound] || compoundColors.UNKNOWN }} />
                    {compound}
                  </span>
                ))}
              </div>
              <div className="pace-medians">
                {distributions.map((g) => (
                  <div key={g.driver}>
                    <strong style={{ color: color(data.drivers, g.driver) }}>{g.driver}</strong>
                    <span>Median <b className="mono">{percentile(g.values, 0.5).toFixed(3)} s</b></span>
                    <small>{g.values.length} laps</small>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Sector pace" eyebrow="SECTOR BY SECTOR">
              <SectorPaceMap data={data} laps={filtered} selected={selected} />
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
