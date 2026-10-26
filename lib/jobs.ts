export type JobStatus = {
  state: "queued" | "processing" | "retry" | "failed" | "succeeded";
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  error_code: string | null;
  progress?: { stage?: string; completed?: number; total?: number };
  effective_retry_at?: string | null;
  daily_budget_exhausted?: boolean;
};
export function jobTiming(job: JobStatus, control: { budget_day: string; daily_attempts: number; daily_limit: number }, now = Date.now()): JobStatus {
  const today = new Date(now).toISOString().slice(0, 10);
  const exhausted = control.budget_day === today && control.daily_attempts >= control.daily_limit;
  const reset = Date.parse(`${today}T00:00:00Z`) + 86400000;
  const due = Date.parse(job.next_attempt_at || "") || now;
  return { ...job, daily_budget_exhausted: exhausted,
    effective_retry_at: new Date(exhausted ? Math.max(due, reset) : due).toISOString() };
}
export const validSessionId = (id: unknown): id is string =>
  typeof id === "string" && /^2026-(0[1-9]|[1-9]\d)-(FP[123]|Q|SQ|S|R)$/.test(id);
export function completedSession(session: { starts_at: string; code: string; status: string }, now = Date.now()) {
  const hours = session.code === "R" ? 3 : ["S", "SQ"].includes(session.code) ? 1.5 : 2;
  return session.status !== "cancelled" && Date.parse(session.starts_at) + hours * 3600000 <= now;
}
export const activeJob = (job: JobStatus | null) => !!job && ["queued", "processing", "retry"].includes(job.state);
