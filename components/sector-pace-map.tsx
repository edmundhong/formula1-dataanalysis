"use client";
import { useMemo, useState } from "react";
import { sectorGeometry, sectorRankings } from "@/lib/sector-map";
import type { Analysis, Lap } from "@/lib/types";

export function SectorPaceMap({ data, laps, selected }: { data: Analysis; laps: Lap[]; selected: string[] }) {
  const [metric, setMetric] = useState<"median" | "fastest">("median");
  const geometry = useMemo(() => sectorGeometry(data), [data]);
  const rankings = useMemo(() => sectorRankings(laps, selected, metric), [laps, selected, metric]);
  const driverColor = (driver?: string) => data.drivers.find((d) => d.code === driver)?.color ?? "#8c93a3";
  const winners = rankings.map((rows) => rows.filter((r) => Math.round(r.seconds * 1000) === Math.round(rows[0].seconds * 1000)));
  const colours = winners.map((rows) => rows.length === 1 ? driverColor(rows[0].driver) : "#8c93a3");
  const points = geometry?.flat() ?? [];
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const xmin = Math.min(...xs), ymin = Math.min(...ys);
  const width = Math.max(...xs) - xmin, height = Math.max(...ys) - ymin;
  const scale = Math.min(560 / (width || 1), 270 / (height || 1));
  const x = (v: number) => 40 + (560 - width * scale) / 2 + (v - xmin) * scale;
  const y = (v: number) => 40 + (270 - height * scale) / 2 + (height - (v - ymin)) * scale;
  return <div className="sector-pace">
    <div className="sector-toolbar" role="group" aria-label="Sector time statistic">
      {(["median", "fastest"] as const).map((value) => <button key={value} aria-pressed={metric === value} onClick={() => setMetric(value)}>{value === "median" ? "Median" : "Fastest"}</button>)}
    </div>
    {geometry ? <svg className="sector-circuit" viewBox="0 0 640 350" role="img" aria-label={`Circuit sectors coloured by fastest ${metric} time among selected drivers`}>
      {geometry.map((section, i) => <g key={i}>
        <polyline points={section.map((p) => `${x(p.x)},${y(p.y)}`).join(" ")} fill="none" stroke="var(--border)" strokeWidth="15" strokeLinejoin="round" />
        <polyline points={section.map((p) => `${x(p.x)},${y(p.y)}`).join(" ")} fill="none" stroke={colours[i]} strokeWidth="9" strokeLinejoin="round"><title>{`Sector ${i + 1}: ${rankings[i].map((r) => `${r.driver} ${r.seconds.toFixed(3)}s`).join(", ") || "No times"}`}</title></polyline>
      </g>)}
      {geometry.map((section, i) => {
        const p = section[Math.floor(section.length / 2)];
        return <g key={i} transform={`translate(${x(p.x)},${y(p.y)})`}><rect x="-19" y="-13" width="38" height="26" rx="8" fill="var(--panel)" stroke={colours[i]} strokeWidth="2" /><text textAnchor="middle" dy="5" fill="var(--text)" fontSize="14" fontWeight="700">S{i + 1}</text></g>;
      })}
      {geometry.map((section, i) => <circle key={i} cx={x(section[0].x)} cy={y(section[0].y)} r="5" fill="var(--text)" stroke="var(--panel)" strokeWidth="2"><title>{i === 0 ? "Start / finish" : `Start of sector ${i + 1}`}</title></circle>)}
    </svg> : <p className="sector-unavailable">Circuit sector coordinates are unavailable for this session.</p>}
    <div className="sector-rankings">{rankings.map((rows, i) => <section key={i} style={{ borderTopColor: colours[i] }} aria-label={`Sector ${i + 1} rankings`}>
      <h3>Sector {i + 1}{winners[i].length > 1 && <small> · Tied</small>}</h3>
      {rows.length ? <ol>{rows.map((r) => <li key={r.driver}><span><i style={{ background: driverColor(r.driver) }} />{r.driver}</span><strong>{r.seconds.toFixed(3)}<small>s</small></strong></li>)}</ol> : <p>No sector times</p>}
    </section>)}</div>
    <p className="footnote">Top 3 selected drivers · {metric === "median" ? "Median" : "Fastest"} times from included laps. {geometry && "Sector boundaries estimated from lap telemetry."}</p>
  </div>;
}
