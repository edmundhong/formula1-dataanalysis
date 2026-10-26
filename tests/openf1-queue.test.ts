import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

test("OpenF1 queue fences checkpoints, preserves legacy artifacts, resumes within budgets and cleans private objects", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(bucket_id text,name text,metadata jsonb,created_at timestamptz default now());`);
    for (const file of ["20260927142616_initial_f1_catalog.sql", "20260927142943_storage_budget.sql", "20260929144015_durable_analysis_queue.sql", "20260930090000_enable_all_2026_session_requests.sql"])
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
    await db.exec(`insert into sessions(id,year,round,event,country,location,code,name,starts_at,artifact_path,version) values
      ('2026-01-Q',2026,1,'Australia','Australia','Melbourne','Q','Qualifying',now()-interval '100 days','old.json','old'),
      ('2026-18-Q',2026,18,'United States','United States','Austin','Q','Qualifying',now()-interval '1 day',null,null);`);
    await db.exec(readFileSync("supabase/migrations/20261025172646_openf1_resumable_ingestion.sql", "utf8"));
    const call = async (sql: string, params: unknown[] = []) => (await db.query<{ value: any }>(`select ${sql} as value`, params)).rows[0].value;
    await db.exec(`update analysis_control set enabled=true;
      insert into analysis_queue(session_id) values ('2026-01-Q'),('2026-18-Q');`);
    assert.equal(await call("claim_analysis(true)"), null);
    await db.exec("update analysis_control set openf1_enabled=true");
    assert.equal(await call("claim_analysis()"), null, "old worker cannot claim an OpenF1 job");
    const first = await call("claim_analysis(true)");
    assert.equal(first.session.id, "2026-18-Q");
    assert.equal(first.provider, "OpenF1");
    assert.equal(await call("claim_analysis(true)"), null);
    assert.equal(await call("reserve_analysis_checkpoint($1,$2,100)", [first.session.id, first.lease_token]), true);
    const sha = "a".repeat(64), path = `${first.session.id}/${first.lease_token}/${sha}.tar.gz`;
    const save = (lease: string, release = true, cooldown = 0) => call("checkpoint_analysis($1,$2,100,$3,$4,'{\"stage\":\"telemetry\",\"completed\":1,\"total\":22}',$5,$6,'{\"session_key\":11392}')",
      [first.session.id, lease, path, sha, cooldown, release]);
    assert.equal(await save("00000000-0000-0000-0000-000000000000"), false);
    assert.equal(await save(first.lease_token, true, Date.now() / 1000 + 120), true);
    assert.equal(await call("(select attempts from analysis_queue where session_id='2026-18-Q')"), 0);
    assert.equal(await call("claim_analysis(true)"), null, "cooldown persisted");
    await db.exec("update analysis_queue set next_attempt_at=now() where session_id='2026-18-Q'");
    const second = await call("claim_analysis(true)");
    assert.equal(second.checkpoint.path, path);
    assert.equal(await save(first.lease_token), false, "old lease cannot overwrite progress");
    assert.equal(await call("publish_analysis($1,$2,'new','new',false,10,0)", [first.session.id, first.lease_token]), false);
    assert.equal(await call("reserve_analysis_checkpoint($1,$2,50331649)", [first.session.id, second.lease_token]), false);
    assert.equal(await call("publish_analysis('2026-01-Q',null,'new','new',false,10,0)"), false);
    assert.equal(await call("(select artifact_path from sessions where id='2026-01-Q')"), "old.json");
    assert.equal(await call("publish_analysis($1,$2,'new.json','new',true,10,0)", [first.session.id, second.lease_token]), true);
    assert.equal(await call("(select count(*)::int from analysis_checkpoints)"), 0);
    assert.equal(await call("has_table_privilege('anon','public.analysis_checkpoints','select')"), false);
    assert.equal(await call("has_function_privilege('anon','public.checkpoint_analysis(text,uuid,bigint,text,text,jsonb,double precision,boolean,jsonb)','execute')"), false);
    assert.equal(await call("has_table_privilege('authenticated','public.analysis_uploads','select')"), false);
    assert.equal(await call("(select public from storage.buckets where id='analysis-checkpoints')"), false);
    await db.exec(`insert into storage.objects(bucket_id,name,metadata,created_at) values
      ('analysis-checkpoints','orphan','{"size":100}',now()-interval '11 minutes'),
      ('analysis-checkpoints','uploading','{"size":200}',now()),
      ('analysis','published','{"size":300}',now());`);
    assert.equal(await call("analysis_storage_bytes()"), 600);
    assert.deepEqual(await call("expired_analysis_checkpoints()"), ["orphan"]);
    await db.exec("update analysis_queue set state='queued',attempts=0,next_attempt_at=now() where session_id='2026-18-Q'; update analysis_control set daily_attempts=12");
    assert.equal(await call("claim_analysis(true)"), null);
    await db.exec("update analysis_control set budget_day=current_date-1");
    const third = await call("claim_analysis(true)");
    assert.ok(third);
    await db.exec("update storage.objects set metadata='{\"size\":786432000}' where bucket_id='analysis'");
    assert.equal(await call("reserve_analysis_checkpoint($1,$2,100)", [first.session.id, third.lease_token]), false, "public and temporary objects share capacity");
    await db.exec("update analysis_queue set attempts=5,lease_expires_at=now()-interval '1 second' where session_id='2026-18-Q'");
    assert.equal(await call("claim_analysis(true)"), null);
    assert.equal(await call("(select state from analysis_queue where session_id='2026-18-Q')"), "failed");
    assert.equal(await call("(select error_code from analysis_queue where session_id='2026-18-Q')"), "lease_expired");
    assert.equal(await call("checkpoint_analysis($1,$2,0,'bad','bad','{}',0,true,'{}')", [first.session.id, third.lease_token]), false);
    await db.exec(`create schema vault; create table vault.decrypted_secrets(name text,decrypted_secret text);
      insert into vault.decrypted_secrets values ('f1_worker_url','https://worker.test'),('f1_worker_token','test');
      create schema net; create table net._http_response(id bigint,status_code integer);
      create table net.calls(id bigserial,url text,body jsonb);
      create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as
        'insert into net.calls(url,body) values(url,body) returning id';
      create schema cron; create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';`);
    await db.exec(readFileSync("supabase/openf1-dispatch.sql", "utf8").replace(/^create extension[^;]+;/gm, ""));
    await db.exec(`update analysis_control set daily_attempts=0,last_dispatch_at=null;
      update analysis_queue set state='succeeded' where session_id='2026-01-Q';
      insert into ingestion_jobs(session_id,last_checked_at,correction_stage) values ('2026-01-Q',now()-interval '30 days',0);
      update analysis_queue set state='queued',attempts=0,next_attempt_at=now() where session_id='2026-18-Q';`);
    await call("dispatch_analysis()");
    assert.equal(await call("(select count(*)::int from net.calls)"), 1);
    assert.equal(await call("(select state from analysis_queue where session_id='2026-01-Q')"), "succeeded", "retained legacy corrections stay frozen");
    await db.exec("update analysis_control set openf1_enabled=false,last_dispatch_at=null");
    await call("dispatch_analysis()");
    assert.equal(await call("(select count(*)::int from net.calls)"), 1);
  } finally { await db.close(); }
});
