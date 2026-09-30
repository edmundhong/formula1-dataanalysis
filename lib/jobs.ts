export type JobStatus = {
  state: "queued" | "processing" | "retry" | "failed" | "succeeded";
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  error_code: string | null;
};
export const validSessionId = (id: unknown): id is string =>
  typeof id === "string" && /^2026-(0[1-9]|[1-9]\d)-(FP[123]|Q|SQ|S|R)$/.test(id);
export function completedSession(session: { starts_at: string; code: string; status: string }, now = Date.now()) {
  const hours = session.code === "R" ? 3 : ["S", "SQ"].includes(session.code) ? 1.5 : 2;
  return session.status !== "cancelled" && Date.parse(session.starts_at) + hours * 3600000 <= now;
}
export const activeJob = (job: JobStatus | null) => !!job && ["queued", "processing", "retry"].includes(job.state);
