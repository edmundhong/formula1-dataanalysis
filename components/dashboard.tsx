"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnalysisJob } from "./analysis-job";
import {
  Activity,
  ArrowRight,
  ChevronDown,
  CircleHelp,
  Clock3,
  Flag,
  Gauge,
  Moon,
  RefreshCw,
  Sun,
  Timer,
  Zap,
} from "lucide-react";
import { configured, loadAnalysis, loadCatalog } from "@/lib/data";
import { bestLaps, formatTime } from "@/lib/analysis";
import {
  emptyAdvanced,
  lapFlags,
  parseAdvanced,
  phaseLabel,
  validateAdvanced,
} from "@/lib/advanced";
import { LapSelection, PaceSelection } from "./advanced-selection";
import { completedSession } from "@/lib/jobs";
import type {
  AdvancedSelection,
  Analysis,
  Lap,
  Session,
  Status,
} from "@/lib/types";
import {
  BestLapPanels,
  PacePanels,
  WeatherPanel,
  type PaceOptions,
} from "./panels";

const statuses: Record<Status, string> = {
  scheduled: "Scheduled",
  waiting: "Waiting for data",
  available: "Available",
  partial: "Partial data",
  delayed: "Update delayed",
  cancelled: "Cancelled",
};
export default function Dashboard() {
  const [advanced, setAdvanced] = useState<AdvancedSelection>(emptyAdvanced);
  const pendingAdvanced = useRef<unknown>(null);
  const [catalog, setCatalog] = useState<Session[]>([]),
    [sessionId, setSessionId] = useState("");
  const [mode, setMode] = useState("best"),
    [phase, setPhase] = useState("ALL"),
    [selected, setSelected] = useState<string[]>([]);
  const [data, setData] = useState<Analysis | null>(null),
    [loading, setLoading] = useState(true),
    [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(""),
    [theme, setTheme] = useState("dark"),
    [help, setHelp] = useState(false);
  const [retry, setRetry] = useState(0);
  const refreshPublished = useCallback(() => setRetry((v) => v + 1), []);
  const [paceOptions, setPaceOptions] = useState<PaceOptions>({
    clean: true,
    compound: "ALL",
    stint: "ALL",
    from: 1,
    to: 999,
  });
  const initial = useRef(true),
    pendingDrivers = useRef<string[]>([]),
    pendingPhase = useRef("ALL"),
    lastSession = useRef("");
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setSessionId(query.get("session") || "");
    setMode(query.get("view") === "pace" ? "pace" : "best");
    pendingDrivers.current = (query.get("drivers") || "")
      .split(",")
      .filter(Boolean)
      .slice(0, 4);
    pendingPhase.current = query.get("phase") || "ALL";
    pendingAdvanced.current = parseAdvanced(query.get("advanced"));
    setPaceOptions({
      clean: query.get("clean") !== "all",
      compound: query.get("compound") || "ALL",
      stint: query.get("stint") || "ALL",
      from: Math.max(1, Number(query.get("from")) || 1),
      to: Math.max(1, Number(query.get("to")) || 999),
    });
    setTheme(document.documentElement.dataset.theme || "dark");
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (!localStorage.getItem("f1-theme")) {
        const value = media.matches ? "dark" : "light";
        setTheme(value);
        document.documentElement.dataset.theme = value;
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    let active = true;
    async function refresh() {
      if (!active) return;
      setRefreshing(true);
      try {
        const rows = await loadCatalog();
        if (!active) return;
        setCatalog(rows);
        setError("");
        setSessionId((current) =>
          rows.some((s) => s.id === current)
            ? current
            : rows.find((s) => s.artifact_path)?.id ||
              rows.find((s) => s.status !== "cancelled")?.id ||
              "",
        );
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Could not load race data.",
          );
      } finally {
        if (active) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }
    refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 300000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [retry]);
  const session = catalog.find((s) => s.id === sessionId);
  useEffect(() => {
    let active = true;
    if (!session?.artifact_path) {
      setData(null);
      return;
    }
    setLoading(true);
    loadAnalysis(session)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError("");
        const changed = lastSession.current !== result.session_id;
        const firstLoad = initial.current;
        setAdvanced((current) =>
          validateAdvanced(
            firstLoad ? pendingAdvanced.current : changed ? null : current,
            result,
          ),
        );
        if (changed && !firstLoad)
          setPaceOptions({
            clean: true,
            compound: "ALL",
            stint: "ALL",
            from: 1,
            to: 999,
          });
        const best = bestLaps(result.laps);
        const choices = result.drivers.map((d) => d.code);
        setSelected((current) => {
          const desired =
            firstLoad && pendingDrivers.current.length
              ? pendingDrivers.current
              : changed
                ? []
                : current;
          const valid = desired.filter((d) => choices.includes(d));
          return valid.length ? valid : best.slice(0, 2).map((l) => l.driver);
        });
        setPhase((current) => {
          const desired = firstLoad
            ? pendingPhase.current
            : changed
              ? "ALL"
              : current;
          return result.phases.includes(desired) ? desired : "ALL";
        });
        initial.current = false;
        lastSession.current = result.session_id;
      })
      .catch((e) => {
        if (active)
          setError(e instanceof Error ? e.message : "Could not load analysis.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session?.id, session?.version, session?.artifact_path, retry]);
  useEffect(() => {
    if (!sessionId || initial.current) return;
    const params = new URLSearchParams({
      session: sessionId,
      view: mode,
      phase,
      drivers: selected.join(","),
    });
    if (paceOptions.compound !== "ALL")
      params.set("compound", paceOptions.compound);
    if (paceOptions.stint !== "ALL") params.set("stint", paceOptions.stint);
    if (paceOptions.from !== 1) params.set("from", String(paceOptions.from));
    if (paceOptions.to !== 999) params.set("to", String(paceOptions.to));
    if (!paceOptions.clean) params.set("clean", "all");
    if (advanced.slots.length || advanced.paceActive)
      params.set("advanced", JSON.stringify(advanced));
    history.replaceState(null, "", `${window.location.pathname}?${params}`);
  }, [sessionId, mode, phase, selected, data, paceOptions, advanced]);
  const years = [...new Set(catalog.map((s) => s.year))].sort((a, b) => b - a);
  const year = session?.year || years[0] || 2026;
  const events = [
    ...new Map(
      catalog.filter((s) => s.year === year).map((s) => [s.round, s]),
    ).values(),
  ].sort((a, b) => b.round - a.round);
  const sessions = catalog
    .filter((s) => s.year === year && s.round === session?.round)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const currentData = data?.session_id === sessionId ? data : null;
  const best = useMemo(
    () => bestLaps(currentData?.laps || [], phase),
    [currentData, phase],
  );
  const chooseEvent = (round: number, newYear = year) => {
    const rows = catalog.filter((s) => s.year === newYear && s.round === round);
    setSessionId(
      rows.find((s) => s.artifact_path)?.id || rows[rows.length - 1]?.id || "",
    );
  };
  const toggleTheme = () => {
    const value = theme === "dark" ? "light" : "dark";
    setTheme(value);
    document.documentElement.dataset.theme = value;
    localStorage.setItem("f1-theme", value);
  };
  const toggleDriver = (code: string) =>
    setSelected((current) =>
      current.includes(code)
        ? current.length > 1
          ? current.filter((d) => d !== code)
          : current
        : current.length < 4
          ? [...current, code]
          : current,
    );
  useEffect(() => {
    if (!advanced.paceActive) return;
    const missing = selected.filter((d) => !advanced.pace[d]);
    if (missing.length)
      setAdvanced((current) => ({
        ...current,
        pace: {
          ...current.pace,
          ...Object.fromEntries(
            missing.map((d) => [d, { ...paceOptions, excluded: [] }]),
          ),
        },
      }));
  }, [selected, advanced.paceActive, advanced.pace, paceOptions]);
  const compareLap = (lap: Lap) => {
    setAdvanced((current) => {
      const slots = current.slots.length
        ? [...current.slots]
        : selected
            .filter((d) => d !== lap.driver)
            .slice(0, 1)
            .map((driver) => ({
              driver,
              phase: "ALL",
              lap: "fastest" as const,
            }));
      const slot = { driver: lap.driver, phase: lap.phase, lap: lap.number };
      if (slots.length < 4) slots.push(slot);
      else slots[3] = slot;
      return {
        ...current,
        slots,
        flagged: current.flagged || Boolean(lapFlags(lap)),
      };
    });
    setMode("best");
  };
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/formula1-dataanalysis">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span>
            FORMULA 1 <b>LAB</b>
          </span>
        </a>
        <div className="topbar-right">
          <span className="desktop-only tiny-label">
            AN INDEPENDENT LOOK AT THE GRID
          </span>
          <div className="header-divider" />
          <button
            className="icon-button"
            onClick={() => setHelp((v) => !v)}
            aria-label="About this analysis"
            aria-expanded={help}
          >
            <CircleHelp size={18} />
          </button>
          <button
            className="icon-button"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <a className="author-link" href="https://edmundhong.com">
            EH
            <ArrowRight size={13} />
          </a>
        </div>
      </header>
      <main>
        <div className="page-intro">
          <div>
            <div className="eyebrow">
              <span className="red-line" />
              THE NUMBERS BEHIND THE RACING
            </div>
            <h1>
              Every lap. <span>A different story.</span>
            </h1>
            <p>
              Explore the speed, strategy and small margins that shape a Grand
              Prix.
            </p>
          </div>
          <div className="season-badge">
            <Flag size={16} />
            <span>{year} SEASON</span>
          </div>
        </div>
        {help && (
          <div className="notice">
            <InfoText />
            <button className="text-button" onClick={() => setHelp(false)}>
              Close
            </button>
          </div>
        )}
        <section className="control-deck" aria-label="Session selection">
          <div className="event-selectors">
            <label>
              <span>SEASON</span>
              <select
                value={year}
                onChange={(e) => {
                  const y = Number(e.target.value);
                  const row =
                    catalog.find((s) => s.year === y && s.artifact_path) ||
                    catalog.find((s) => s.year === y);
                  if (row) chooseEvent(row.round, y);
                }}
                disabled={!catalog.length}
              >
                {(years.length ? years : [2026]).map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </label>
            <label className="event-selector">
              <span>GRAND PRIX</span>
              <select
                value={session?.round || ""}
                onChange={(e) => chooseEvent(Number(e.target.value))}
                disabled={!events.length}
              >
                {!events.length && <option value="">Loading calendar…</option>}
                {events.map((e) => (
                  <option key={e.round} value={e.round}>
                    {String(e.round).padStart(2, "0")} · {e.event}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>SESSION</span>
              <select
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                disabled={!sessions.length}
              >
                {!sessions.length && <option value="">—</option>}
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.artifact_path ? "" : " · pending"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="update-indicator">
            <span
              className={`status-dot ${session?.artifact_path ? "ready" : ""}`}
            />
            <div>
              <strong>
                {session ? statuses[session.status] : "Connecting"}
              </strong>
              <small>
                {session?.updated_at
                  ? `Updated ${new Date(session.updated_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                  : "Post-session data availability"}
              </small>
            </div>
            <button
              className={`icon-button ${refreshing ? "spinning" : ""}`}
              onClick={() => setRetry((v) => v + 1)}
              disabled={refreshing}
              aria-label="Refresh available session data"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </section>
        {session && session.status !== "cancelled" && (
          <AnalysisJob
            key={session.id}
            session={session}
            onPublished={refreshPublished}
          />
        )}
        <div className="view-bar">
          <div className="view-tabs" role="tablist" aria-label="Analysis view">
            <button
              role="tab"
              aria-selected={mode === "best"}
              aria-controls="analysis-content"
              className={mode === "best" ? "active" : ""}
              onClick={() => setMode("best")}
            >
              <Zap size={16} />
              Best Lap<span>01</span>
            </button>
            <button
              role="tab"
              aria-selected={mode === "pace"}
              aria-controls="analysis-content"
              className={mode === "pace" ? "active" : ""}
              onClick={() => setMode("pace")}
            >
              <Activity size={16} />
              Race Pace<span>02</span>
            </button>
          </div>
          <span className="post-session">
            <Clock3 size={13} />
            Post-session analysis
          </span>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setRetry((v) => v + 1)}>Retry</button>
          </div>
        )}
        {loading && !currentData ? (
          <div className="loading-state" aria-live="polite">
            <div className="loading-bar" />
            <Timer size={28} />
            <h2>Preparing the pit wall</h2>
            <p>Loading session timing and telemetry…</p>
          </div>
        ) : !currentData ? (
          <div className="waiting-state">
            {session && completedSession(session) ? (
              <Timer size={32} />
            ) : (
              <Flag size={32} />
            )}
            <span className="eyebrow">
              {session && completedSession(session)
                ? "PULLING FASTF1 DATA"
                : session
                  ? statuses[session.status]
                  : "DATA CONNECTION"}
            </span>
            <h2>
              {session?.status === "cancelled"
                ? "This session is cancelled"
                : session && completedSession(session)
                  ? `Preparing ${session.name} stats`
                  : session
                    ? `${session.name} analysis is not available yet`
                    : configured
                      ? "The first sessions are being prepared"
                      : "The data connection is being set up"}
            </h2>
            <p>
              {session && completedSession(session)
                ? `We’re pulling ${session.event} timing and telemetry from FastF1. This page will update automatically when it is ready.`
                : session
                  ? `${session.event} · ${new Date(session.starts_at).toLocaleString()}`
                  : "The calendar will appear as soon as the first ingestion completes."}
            </p>
            {!session || !completedSession(session) ? (
              <p>
                Completed sessions are pulled from FastF1 automatically and the
                stats will appear here when the analysis is ready.
              </p>
            ) : null}
          </div>
        ) : (
          <div id="analysis-content" role="tabpanel">
            <div className="session-heading">
              <div>
                <span className="eyebrow">
                  ROUND {String(session?.round).padStart(2, "0")}{" "}
                  <span className="muted">
                    / {session?.location?.toUpperCase()}
                  </span>
                </span>
                <h2>
                  {session?.event}
                  <span>{session?.name}</span>
                </h2>
              </div>
              {mode === "best" && currentData.phases.length > 1 && (
                <label className="segment-picker">
                  Qualifying segment
                  <select
                    value={phase}
                    onChange={(e) => setPhase(e.target.value)}
                  >
                    {currentData.phases.map((p) => (
                      <option key={p} value={p}>
                        {phaseLabel(p, session?.code || "Q")}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="stat-grid">
              <div className="stat-card">
                <span>
                  <Timer size={14} />
                  FASTEST LAP
                </span>
                <strong className="mono">{formatTime(best[0]?.time)}</strong>
                <small>
                  {best[0]?.driver || "—"}{" "}
                  <span className="muted">/ Lap {best[0]?.number || "—"}</span>
                </small>
              </div>
              <div className="stat-card">
                <span>
                  <Gauge size={14} />
                  CLOSEST CHALLENGER
                </span>
                <strong className="mono">
                  {best.length > 1
                    ? `+${(best[1].time! - best[0].time!).toFixed(3)}`
                    : "—"}
                  <em>s</em>
                </strong>
                <small>
                  {best[1]?.driver || "—"}{" "}
                  <span className="muted">
                    to {best[0]?.driver || "leader"}
                  </span>
                </small>
              </div>
              <div className="stat-card">
                <span>
                  <Activity size={14} />
                  LAPS RECORDED
                </span>
                <strong className="mono">
                  {currentData.laps.filter((l) => l.time != null).length}
                </strong>
                <small>
                  {currentData.drivers.length} drivers{" "}
                  <span className="muted">in the session</span>
                </small>
              </div>
              <div className="stat-card">
                <span>
                  <Flag size={14} />
                  TRACK CONDITIONS
                </span>
                <strong>
                  {currentData.weather.length
                    ? currentData.weather.some((w) => w.rain)
                      ? "Rain recorded"
                      : "No rain"
                    : "Unavailable"}
                </strong>
                <small>
                  {currentData.weather.length
                    ? "Session weather observations"
                    : "Weather data pending"}
                </small>
              </div>
            </div>
            <div className="driver-picker">
              <div>
                <span className="eyebrow">COMPARE DRIVERS</span>
                <small>Select up to four</small>
              </div>
              <div className="driver-chips">
                {currentData.drivers.map((d) => (
                  <button
                    key={d.code}
                    aria-pressed={selected.includes(d.code)}
                    disabled={
                      !selected.includes(d.code) && selected.length >= 4
                    }
                    onClick={() => toggleDriver(d.code)}
                    className={selected.includes(d.code) ? "active" : ""}
                    style={{ "--driver-color": d.color } as React.CSSProperties}
                    title={`${d.name} · ${d.team}`}
                  >
                    <i />
                    {d.code}
                    {selected.includes(d.code) && <span>✓</span>}
                  </button>
                ))}
              </div>
            </div>
            {currentData.unavailable.length > 0 && (
              <div className="data-note">
                {currentData.unavailable.join(" ")} Available analysis remains
                usable.
              </div>
            )}
            {mode === "best" ? (
              <>
                <LapSelection
                  data={currentData}
                  code={session?.code || ""}
                  selected={selected}
                  phase={phase}
                  value={advanced}
                  onChange={setAdvanced}
                />
                <BestLapPanels
                  data={currentData}
                  selected={selected}
                  phase={phase}
                  theme={theme}
                  session={session!}
                  advanced={advanced}
                />
              </>
            ) : (
              <>
                <PaceSelection
                  data={currentData}
                  selected={selected}
                  defaults={paceOptions}
                  value={advanced}
                  onChange={setAdvanced}
                  onCompare={compareLap}
                />
                <PacePanels
                  key={currentData.session_id}
                  data={currentData}
                  session={session!}
                  selected={selected}
                  theme={theme}
                  filters={paceOptions}
                  onFilters={setPaceOptions}
                  advanced={advanced}
                />
              </>
            )}
            <WeatherPanel data={currentData} theme={theme} />
          </div>
        )}
        <footer>
          <div>
            <span className="brand-mark small">
              <i />
              <i />
              <i />
            </span>
            <strong>FORMULA 1 LAB</strong>
            <span>Built by Edmund Hong</span>
          </div>
          <p>
            Data via FastF1 · Independent analysis · Not affiliated with Formula
            1 or the FIA.
          </p>
          <a
            href="https://github.com/edmundhong/formula1-dataanalysis"
            target="_blank"
            rel="noreferrer"
          >
            View the project <ArrowRight size={13} />
          </a>
        </footer>
      </main>
    </div>
  );
}
function InfoText() {
  return (
    <p>
      This is independent post-session analysis using FastF1 data. Sessions from
      2026 sessions appear in the calendar. FastF1 source availability and
      worker capacity can affect publication. Track dominance and telemetry
      deltas are estimates. Race-pace comparisons do not correct for fuel,
      traffic, or weather.
    </p>
  );
}
