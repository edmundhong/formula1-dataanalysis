import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "../app/api/jobs/route";

test("public job API validates input, origin, limits and hides client identifiers", async () => {
  const old = { ...process.env };
  const originalFetch = globalThis.fetch;
  try {
    process.env.F1_QUEUE_ENABLED = "0";
    assert.equal((await GET(new Request("https://app.test/api/jobs?session_id=invalid"))).status, 400);
    assert.deepEqual(await (await GET(new Request("https://app.test/api/jobs?session_id=2026-01-Q"))).json(), { enabled: false, job: null });
    process.env.F1_QUEUE_ENABLED = "1";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
    process.env.F1_CLIENT_HASH_SECRET = "test-hash-secret";
    process.env.F1_PUBLIC_ORIGIN = "https://public.test";
    process.env.VERCEL = "1";
    const request = (body: string, origin = "https://public.test") => new Request("https://app.test/api/jobs", {
      method: "POST", headers: { origin, "Content-Type": "application/json", "x-vercel-forwarded-for": "192.0.2.1" }, body,
    });
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.p_session, "2026-01-Q");
      assert.match(body.p_client, /^[a-f0-9]{64}$/);
      assert.ok(!String(init?.body).includes("192.0.2.1"));
      return Response.json({ result: calls === 1 ? "queued" : "limited", job: null });
    };
    assert.equal((await POST(request('{"session_id":"2026-01-Q"}', "https://attacker.test"))).status, 403);
    assert.equal((await POST(request('{"session_id":"https://attacker.test"}'))).status, 400);
    assert.equal((await POST(request("x".repeat(257)))).status, 400);
    assert.equal((await POST(request('{"session_id":"2026-01-Q","url":"https://attacker.test"}'))).status, 400);
    assert.equal(calls, 0);
    assert.equal((await POST(request('{"session_id":"2026-01-Q"}'))).status, 202);
    assert.equal((await POST(request('{"session_id":"2026-01-Q"}'))).status, 429);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
