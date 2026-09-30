import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { validSessionId } from "@/lib/jobs";

export const dynamic = "force-dynamic";
function database() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || process.env.F1_QUEUE_ENABLED !== "1") return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("session_id");
  if (!validSessionId(id)) return reply({ error: "Invalid session." }, 400);
  const db = database();
  if (!db) return reply({ enabled: false, job: null });
  const control = await db.from("analysis_control").select("enabled").eq("id", true).single();
  if (control.error) return reply({ error: "Job status is temporarily unavailable." }, 503);
  const { data, error } = await db.from("analysis_queue")
    .select("state,attempts,last_attempt_at,next_attempt_at,error_code").eq("session_id", id).maybeSingle();
  if (error) return reply({ error: "Job status is temporarily unavailable." }, 503);
  return reply({ enabled: control.data.enabled, job: data });
}
export async function POST(request: Request) {
  const db = database();
  const salt = process.env.F1_CLIENT_HASH_SECRET;
  if (!db || !salt) return reply({ error: "Analysis requests are not enabled yet." }, 503);
  const origin = process.env.F1_PUBLIC_ORIGIN || new URL(request.url).origin;
  if (request.headers.get("origin") !== origin) return reply({ error: "Invalid origin." }, 403);
  // Vercel overwrites this header. Never trust the caller's x-forwarded-for.
  const ip = process.env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for") : "local";
  if (!ip) return reply({ error: "Client could not be identified." }, 400);
  let body;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error();
    let text = "";
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > 256) { await reader.cancel(); throw new Error(); }
    }
    body = JSON.parse(text);
  } catch { return reply({ error: "Invalid request." }, 400); }
  if (!body || Object.keys(body).length !== 1 || !validSessionId(body.session_id)) return reply({ error: "Invalid session." }, 400);
  const client = createHmac("sha256", salt).update(ip).digest("hex");
  const { data, error } = await db.rpc("enqueue_analysis", { p_session: body.session_id, p_client: client });
  if (error) return reply({ error: "Could not queue this session. Please try later." }, 503);
  const status = data.result === "limited" ? 429 : data.result === "ineligible" ? 409 : 202;
  return reply(data, status);
}
