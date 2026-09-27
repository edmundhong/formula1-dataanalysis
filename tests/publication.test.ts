import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarChanges,
  publicationPath,
} from "../supabase/functions/_shared/policy";
test("calendar detects reschedules, cancellations and returning sessions", () => {
  const before = [
    { id: "a", starts_at: "2026-04-01T12:00:00Z" },
    { id: "b", starts_at: "2026-05-01T12:00:00Z", status: "cancelled" },
    { id: "c", starts_at: "2026-06-01T12:00:00Z" },
    { id: "d", starts_at: "2026-03-01T12:00:00Z", artifact_path: "published" },
  ];
  const after = [
    { id: "a", starts_at: "2026-04-02T12:00:00Z" },
    { id: "b", starts_at: "2026-05-01T12:00:00Z" },
  ];
  assert.deepEqual(calendarChanges(before, after), {
    removed: ["c"],
    returned: ["b"],
    moved: ["a"],
  });
});
test("duplicate publication uses the same immutable path; corrections use a new path", () => {
  const one = publicationPath("2026-01-Q", 2026, "a".repeat(20));
  assert.equal(one, publicationPath("2026-01-Q", 2026, "a".repeat(20)));
  assert.notEqual(one, publicationPath("2026-01-Q", 2026, "b".repeat(20)));
  assert.throws(() => publicationPath("2025-01-Q", 2025, "a".repeat(20)));
  assert.throws(() => publicationPath("../../other", 2026, "a".repeat(20)));
});
