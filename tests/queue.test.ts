import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { completedSession, validSessionId } from "../lib/jobs";

test("request IDs and completed-session eligibility", () => {
  assert.ok(validSessionId("2026-12-R"));
  for (const id of ["2025-01-Q", "2026-00-Q", "https://example.com", null]) assert.equal(validSessionId(id), false);
  assert.equal(completedSession({ starts_at: "2026-01-01T00:00:00Z", code: "R", status: "waiting" }, Date.parse("2026-01-01T02:00:00Z")), false);
});

test("queue SQL enforces admission, leases, recovery, publication fencing and permissions", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    await db.exec(readFileSync("supabase/migrations/20260927142616_initial_f1_catalog.sql", "utf8"));
    await db.exec(readFileSync("supabase/migrations/20260929144015_durable_analysis_queue.sql", "utf8"));
    await db.exec(`insert into sessions(id,year,round,event,country,location,code,name,starts_at)
      values ('2026-01-Q',2026,1,'Test','Test','Test','Q','Qualifying',now()-interval '100 days'),
      ('2026-12-R',2026,12,'Test','Test','Test','R','Race',now()-interval '50 days'),
      ('2026-02-R',2026,2,'Test','Test','Test','R','Race',now()+interval '1 day');`);
    const call = async (sql: string, params: unknown[] = []) => (await db.query<{ value: any }>(`select ${sql} as value`, params)).rows[0].value;
    const enqueue = (id: string, client = "a".repeat(64)) => call("enqueue_analysis($1,$2)", [id, client]);
    assert.equal((await enqueue("2026-01-Q")).result, "ineligible");
    await db.exec("update analysis_control set enabled=true");
    assert.equal((await enqueue("2026-02-R")).result, "ineligible");
    assert.equal((await enqueue("2026-01-Q")).result, "queued");
    assert.equal((await enqueue("2026-01-Q")).result, "existing");
    await enqueue("2026-12-R");
    await enqueue("2026-01-Q"); await enqueue("2026-01-Q");
    assert.equal((await enqueue("2026-01-Q")).result, "limited");
    const first = await call("claim_analysis()");
    assert.equal(first.session.id, "2026-01-Q");
    assert.equal(await call("claim_analysis()"), null);
    assert.equal(await call("heartbeat_analysis($1,$2)", [first.session.id, first.lease_token]), true);
    await db.exec("update analysis_queue set lease_expires_at=now()-interval '1 second' where state='processing'");
    const second = await call("claim_analysis()");
    assert.equal(second.session.id, "2026-12-R");
    assert.equal(await call("publish_analysis($1,$2,'old','old',false,10,0)", [first.session.id, first.lease_token]), false);
    assert.equal(await call("publish_analysis($1,$2,'new','new',false,4195000,2)", [second.session.id, second.lease_token]), true);
    assert.equal(await call("(select artifact_bytes::int from ingestion_jobs where session_id='2026-12-R')"), 4195000);
    assert.equal(await call("publish_analysis($1,$2,'stale','stale',false,10,0)", [second.session.id, second.lease_token]), false);
    assert.equal(await call("publish_analysis($1,null,'legacy','legacy',false,10,0)", [second.session.id]), false);
    assert.equal(await call("(select artifact_path from sessions where id='2026-12-R')"), "new");
    // Historical failures remain eligible after backoff; terminal jobs cannot be reset by visitors.
    await db.exec("update analysis_queue set next_attempt_at=now()-interval '1 second',attempts=4 where state='retry'");
    const third = await call("claim_analysis()");
    assert.equal(third.session.id, first.session.id);
    assert.equal(await call("fail_analysis($1,$2,'source_unavailable')", [third.session.id, third.lease_token]), true);
    assert.equal((await enqueue(first.session.id, "b".repeat(64))).job.state, "failed");
    assert.equal(await call("(select count(*)::int from analysis_alerts)"), 1);
    assert.equal(await call("has_function_privilege('anon','public.claim_analysis()','execute')"), false);
    assert.equal(await call("has_table_privilege('anon','public.analysis_queue','select')"), false);
    assert.equal(await call("has_function_privilege('service_role','public.claim_analysis()','execute')"), true);
    // Budget survives separate invocations and resets on the next UTC database day.
    await db.exec("update analysis_queue set state='queued',attempts=0; update analysis_control set daily_attempts=daily_limit");
    assert.equal(await call("claim_analysis()"), null);
    await db.exec("update analysis_control set budget_day=current_date-1; update analysis_queue set next_attempt_at=now()");
    assert.ok(await call("claim_analysis()"));
    // Execute the real dispatch SQL with deterministic network/Vault stand-ins.
    await db.exec(`create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text);
      insert into vault.decrypted_secrets values ('f1_worker_url','https://worker.test/api/analysis'),('f1_worker_token','test-only'),('f1_owner_alert_url','https://owner.test');
      create schema net; create table net._http_response(id bigint,status_code integer);
      create table net.calls(id bigserial,url text,body jsonb);
      create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as
      'insert into net.calls(url,body) values(url,body) returning id';
      create schema cron; create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';`);
    await db.exec(readFileSync("supabase/queue-dispatch.sql", "utf8").replace(/^create extension[^;]+;/gm, ""));
    await db.exec("delete from analysis_queue; insert into analysis_queue(session_id) values ('2026-01-Q'); update analysis_control set daily_attempts=0,last_dispatch_at=null");
    await call("dispatch_analysis()");
    assert.equal(await call("(select count(*)::int from net.calls where url like '%worker%')"), 1);
    assert.equal(await call("(select count(*)::int from net.calls where url like '%owner%')"), 0);
    await db.exec("delete from vault.decrypted_secrets where name='f1_owner_alert_url'; update analysis_control set last_dispatch_at=now()-interval '7 minutes'");
    await call("dispatch_analysis()");
    assert.equal(await call("(select count(*)::int from net.calls where url like '%worker%')"), 2);
    assert.equal(await call("(select count(*)::int from net.calls where url like '%owner%')"), 0);
    await db.exec("insert into vault.decrypted_secrets values ('f1_owner_alert_url','https://owner.test'); update analysis_control set alerts_enabled=true");
    await call("dispatch_analysis()");
    assert.equal(await call("(select count(*)::int from net.calls where url like '%worker%')"), 2);
    await db.exec("update analysis_control set last_dispatch_at=now()-interval '7 minutes'");
    await call("dispatch_analysis()");
    assert.equal(await call("(select count(*)::int from net.calls where url like '%worker%')"), 3);
    assert.equal(await call("(select count(*)::int from net.calls where url like '%owner%')"), 1);
    await db.exec("insert into net._http_response select request_id,200 from analysis_alerts");
    await call("dispatch_analysis()");
    assert.equal(await call("(select count(*)::int from analysis_alerts where delivered_at is not null)"), 1);
    // Both visitor and scheduled admission obey the global capacity.
    await db.exec(`delete from analysis_queue;
      insert into sessions(id,year,round,event,country,location,code,name,starts_at)
      select '2026-'||lpad(n::text,2,'0')||'-FP1',2026,n,'Test','Test','Test','FP1','Practice',now()-interval '10 days' from generate_series(1,21) n;
      update analysis_control set allowed_sessions=(select array_agg(id) from sessions where code='FP1');`);
    for (let n = 1; n <= 20; n++) assert.equal((await enqueue(`2026-${String(n).padStart(2,"0")}-FP1`, n.toString(16).padStart(64,"0"))).result, "queued");
    assert.equal((await enqueue("2026-21-FP1", "f".repeat(64))).result, "limited");
    await call("dispatch_analysis()");
    assert.equal(await call("(select count(*)::int from analysis_queue)"), 20);
    // The follow-up migration removes pilot-only admission while preserving the
    // same durable queue protections for every completed 2026 session.
    await db.exec("delete from analysis_queue; update analysis_control set daily_attempts=0,budget_day=current_date");
    await db.exec(`insert into sessions(id,year,round,event,country,location,code,name,starts_at)
      values ('2026-22-FP2',2026,22,'Test','Test','Test','FP2','Practice 2',now()-interval '10 days');`);
    await db.exec(readFileSync("supabase/migrations/20260930090000_enable_all_2026_session_requests.sql", "utf8"));
    assert.equal((await enqueue("2026-22-FP2", "e".repeat(64))).result, "queued");
    assert.equal((await call("claim_analysis()")).session.id, "2026-22-FP2");
  } finally { await db.close(); }
});
