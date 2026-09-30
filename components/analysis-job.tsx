"use client";
import { useEffect, useRef, useState } from "react";
import { activeJob, completedSession, type JobStatus } from "@/lib/jobs";
import type { Session } from "@/lib/types";

export function AnalysisJob({ session, onPublished }: { session: Session; onPublished: () => void }) {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const requested = useRef("");
  const endpoint = `/formula1-dataanalysis/api/jobs?session_id=${encodeURIComponent(session.id)}`;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (!alive) return;
        setEnabled(result.enabled); setJob(result.job); setError("");
        if (result.job?.state === "succeeded" && !session.artifact_path) onPublished();
        if (
          result.enabled &&
          !result.job &&
          !session.artifact_path &&
          completedSession(session) &&
          requested.current !== session.id
        ) {
          requested.current = session.id;
          void enqueue();
        }
        timer = setTimeout(poll, activeJob(result.job) ? 10000 : 60000);
      } catch {
        if (alive) { setError("Job status is temporarily unavailable."); timer = setTimeout(poll, 30000); }
      }
    }
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [endpoint, session, session.artifact_path, onPublished, refresh]);
  async function enqueue() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/formula1-dataanalysis/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || (response.status === 429 ? "Request limit reached. Please try later." : "This session cannot be requested yet."));
      setJob(result.job);
      setRefresh((value) => value + 1);
      if (result.result === "available") onPublished();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not queue analysis."); }
    finally { setBusy(false); }
  }
  const labels = { queued: "Waiting to pull FastF1 data", processing: "Pulling FastF1 data and preparing stats", retry: "Waiting to retry FastF1 data", failed: "Analysis needs attention", succeeded: "Analysis published" };
  if (session.artifact_path && (!job || job.state === "succeeded")) return null;
  return <div className="notice" aria-live="polite">
    <div>
      <strong>{busy ? "Requesting FastF1 data" : job ? labels[job.state] : enabled ? "Preparing FastF1 data request" : "Analysis service is unavailable"}</strong>
      {job?.last_attempt_at && <p>Last attempt: {new Date(job.last_attempt_at).toLocaleString()} · Attempt {job.attempts}</p>}
      {job?.state === "retry" && job.next_attempt_at && <p>Retry eligible after {new Date(job.next_attempt_at).toLocaleString()}.</p>}
      {activeJob(job) && <p>Keep this page open or come back shortly. The stats will appear automatically once the session is ready.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
    {enabled && !session.artifact_path && completedSession(session) && !activeJob(job) && job?.state !== "failed" && <button className="text-button" disabled={busy} onClick={enqueue}>{busy ? "Requesting…" : "Try again"}</button>}
  </div>;
}
