import { createClient } from "@supabase/supabase-js";
import type { Analysis, Session } from "./types";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
export const configured = Boolean(url && key);
const client = configured
  ? createClient(url!, key!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;
export async function loadCatalog(): Promise<Session[]> {
  if (!client) throw new Error("The data connection is not configured yet.");
  const { data, error } = await client
    .from("sessions")
    .select(
      "id,year,round,event,country,location,code,name,starts_at,status,artifact_path,version,updated_at",
    )
    .gte("year", 2026)
    .order("starts_at", { ascending: false })
    .limit(2000);
  if (error)
    throw new Error(
      "Race data is temporarily unavailable. Please try again shortly.",
    );
  return data as Session[];
}
export async function loadAnalysis(session: Session): Promise<Analysis> {
  if (!client || !session.artifact_path)
    throw new Error("Session data has not been published yet.");
  const { data } = client.storage
    .from("analysis")
    .getPublicUrl(session.artifact_path);
  const response = await fetch(data.publicUrl, { cache: "force-cache" });
  if (!response.ok)
    throw new Error("This session could not be loaded. Please retry.");
  const result = await response.json();
  if (
    result.schema_version !== 1 ||
    result.session_id !== session.id ||
    !Array.isArray(result.laps)
  )
    throw new Error("This session uses an unsupported data format.");
  return result;
}
