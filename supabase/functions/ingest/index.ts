import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { calendarChanges, publicationPath } from "../_shared/policy.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const reply = (value: unknown, status = 200) =>
  Response.json(value, { status });
const check = (result: { error: unknown }) => {
  if (result.error) throw result.error;
};
const validId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^20\d{2}-\d{2}-(FP[123]|Q|SQ|S|R)$/.test(id) &&
  Number(id.slice(0, 4)) === 2026;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const expected = Deno.env.get("F1_INGEST_TOKEN_HASH");
  const token = req.headers.get("x-ingest-token") || "";
  if (!expected || token.length < 32 || token.length > 256)
    return reply({ error: "Unauthorized" }, 401);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  let mismatch = digest.length ^ expected.length;
  for (let i = 0; i < digest.length; i++)
    mismatch |= digest.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  if (mismatch) return reply({ error: "Unauthorized" }, 401);
  try {
    const text = await req.text();
    if (text.length > 12 * 1024 * 1024)
      return reply({ error: "Payload too large" }, 413);
    const body = JSON.parse(text),
      now = new Date().toISOString();
    if (body.action === "state") {
      const [sessions, jobs, state] = await Promise.all([
        db
          .from("sessions")
          .select("*")
          .order("starts_at", { ascending: false })
          .limit(2000),
        db.from("ingestion_jobs").select("*").limit(2000),
        db
          .from("ingestion_state")
          .select("value")
          .eq("key", "calendar_checked_at")
          .maybeSingle(),
      ]);
      check(sessions);
      check(jobs);
      check(state);
      const jobMap = new Map(jobs.data?.map((j) => [j.session_id, j]));
      return reply({
        sessions: sessions.data?.map((s) => ({ ...s, ...jobMap.get(s.id) })),
        calendar_checked_at: state.data?.value || null,
      });
    }
    if (body.action === "calendar") {
      if (
        !Number.isInteger(body.year) ||
        body.year !== 2026 ||
        !Array.isArray(body.sessions) ||
        !body.sessions.length ||
        body.sessions.length > 200
      )
        return reply({ error: "Invalid calendar" }, 400);
      const rows = body.sessions.map((s: Record<string, unknown>) => {
        if (
          !validId(s.id) ||
          s.year !== body.year ||
          !Number.isInteger(s.round) ||
          typeof s.starts_at !== "string" ||
          !Number.isFinite(Date.parse(s.starts_at))
        )
          throw new Error("Invalid calendar row");
        return {
          id: s.id,
          year: s.year,
          round: s.round,
          event: String(s.event).slice(0, 200),
          country: String(s.country).slice(0, 100),
          location: String(s.location).slice(0, 100),
          code: s.code,
          name: String(s.name).slice(0, 100),
          starts_at: s.starts_at,
        };
      });
      const existing = await db
        .from("sessions")
        .select("id,starts_at,status,artifact_path")
        .eq("year", body.year);
      check(existing);
      check(await db.from("sessions").upsert(rows, { onConflict: "id" }));
      check(
        await db.from("ingestion_jobs").upsert(
          rows.map((s: { id: string }) => ({ session_id: s.id })),
          { onConflict: "session_id", ignoreDuplicates: true },
        ),
      );
      const { removed, returned, moved } = calendarChanges(
        existing.data || [],
        rows,
      );
      if (removed.length)
        check(
          await db
            .from("sessions")
            .update({ status: "cancelled" })
            .in("id", removed),
        );
      if (returned.length)
        check(
          await db
            .from("sessions")
            .update({ status: "scheduled" })
            .in("id", returned),
        );
      if (moved.length)
        check(
          await db
            .from("ingestion_jobs")
            .update({ last_checked_at: null, correction_stage: 0 })
            .in("session_id", moved),
        );
      check(
        await db
          .from("sessions")
          .update({ status: "waiting" })
          .eq("status", "scheduled")
          .lt("starts_at", now),
      );
      check(
        await db
          .from("ingestion_state")
          .upsert({ key: "calendar_checked_at", value: now }),
      );
      return reply({ count: rows.length });
    }
    if (!validId(body.session_id))
      return reply({ error: "Invalid session" }, 400);
    const lookup = await db
      .from("sessions")
      .select("*")
      .eq("id", body.session_id)
      .single();
    check(lookup);
    const session = lookup.data;
    const queued = await db.from("analysis_queue").select("state,lease_token,lease_expires_at").eq("session_id", session.id).maybeSingle();
    check(queued);
    if (queued.data && (!body.lease_token || body.lease_token !== queued.data.lease_token || queued.data.state !== "processing" || Date.parse(queued.data.lease_expires_at) <= Date.now()))
      return reply({ error: "Inactive worker lease" }, 409);
    if (body.lease_token && !queued.data) return reply({ error: "Unknown worker lease" }, 409);
    if (body.action === "failed") {
      check(
        await db
          .from("ingestion_jobs")
          .update({
            last_checked_at: now,
            last_error: String(body.message).slice(0, 100),
          })
          .eq("session_id", session.id),
      );
      check(
        await db
          .from("sessions")
          .update({ status: session.artifact_path ? "delayed" : "waiting" })
          .eq("id", session.id),
      );
      return reply({ retained: session.version });
    }
    if (body.action !== "publish")
      return reply({ error: "Unknown action" }, 400);
    const artifact = body.artifact;
    if (
      !/^[a-f0-9]{20}$/.test(body.version) ||
      artifact?.schema_version !== 1 ||
      artifact.session_id !== session.id ||
      !Array.isArray(artifact.laps) ||
      !artifact.laps.length ||
      !Array.isArray(artifact.traces) ||
      !Array.isArray(artifact.unavailable)
    )
      return reply({ error: "Invalid artifact" }, 400);
    const bytes = new TextEncoder().encode(JSON.stringify(artifact));
    if (bytes.byteLength > 12 * 1024 * 1024)
      return reply({ error: "Artifact too large" }, 413);
    const path = publicationPath(session.id, session.year, body.version);
    if (session.version !== body.version) {
      const usage = await db.rpc("analysis_storage_bytes");
      check(usage);
      if (Number(usage.data) + bytes.byteLength > 750 * 1024 * 1024)
        return reply(
          { error: "Free storage budget reached; existing data retained" },
          507,
        );
      const upload = await db.storage
        .from("analysis")
        .upload(path, bytes, {
          contentType: "application/json",
          cacheControl: "31536000",
          upsert: false,
        });
      // A retry after an interrupted publication can find the immutable file already present.
      if (
        upload.error &&
        !["409", "Duplicate"].includes(String(upload.error.statusCode)) &&
        !upload.error.message.toLowerCase().includes("already exists")
      )
        throw upload.error;
    }
    // The artifact exists before the public pointer changes. Readers never see partial files.
    const committed = await db.rpc("publish_analysis", {
      p_session: session.id, p_lease: body.lease_token || null, p_path: path,
      p_version: body.version, p_partial: artifact.unavailable.length > 0,
      p_bytes: bytes.byteLength, p_stage: Math.max(0, Math.min(2, Math.trunc(Number(body.correction_stage) || 0))),
    });
    check(committed);
    if (!committed.data) return reply({ error: "Worker lease expired or session changed; previous data retained" }, 409);
    const prefix = `${session.year}/${session.id}`;
    const objects = await db.storage
      .from("analysis")
      .list(prefix, { limit: 1000 });
    if (!objects.error) {
      const old = objects.data
        .filter(
          (o) =>
            o.name !== `${body.version}.json` &&
            o.name !== `${session.version}.json` &&
            Date.parse(o.created_at) < Date.now() - 7 * 86400000,
        )
        .map((o) => `${prefix}/${o.name}`);
      if (old.length) await db.storage.from("analysis").remove(old);
    }
    return reply({ version: body.version, bytes: bytes.byteLength });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Ingestion failure");
    return reply({ error: "Ingestion failed; previous data retained" }, 500);
  }
});
