import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  FOLD_EVENT_TYPES,
  isOtlpLaneRow,
  OTLP_FOLD_EVENT_TYPES,
} from "@/lib/ingest/trace-events/event-types";

/**
 * The fold's partial index predicate is SQL text in the schema and in the
 * migration that created it, so it cannot reference the TypeScript lists.
 * This keeps the three from drifting: a type the reader learns from but the
 * index does not cover would fall off the index silently. The index is
 * type-only, a superset of `foldableEventPredicate` (the one predicate the
 * reader and the cron safety net share), which is what lets Postgres use it
 * for both.
 */
test("the fold index predicate names exactly the types the fold reads, in schema and migration alike", () => {
  const expected = [...FOLD_EVENT_TYPES, ...OTLP_FOLD_EVENT_TYPES].map((t) => `'${t}'`).join(", ");
  const predicate = /trace_events_project_received_fold_idx[\s\S]{0,400}?in \(([^)]*)\)/;
  for (const file of [
    "lib/ingest/trace-events/schema.ts",
    "lib/platform/db/migrations/0000_init.sql",
  ]) {
    const match = readFileSync(file, "utf8").match(predicate);
    assert.ok(match, `${file}: fold index predicate not found`);
    assert.equal(
      match[1],
      expected,
      `${file}: the index predicate drifted from the fold's type lists`,
    );
  }
});

test("the OTLP lane is the plain-trace types on the otlp ingest source only", () => {
  assert.equal(isOtlpLaneRow({ type: "otlp_model_call", ingestSource: "otlp" }), true);
  assert.equal(isOtlpLaneRow({ type: "invoke_error", ingestSource: "otlp" }), true);
  assert.equal(
    isOtlpLaneRow({ type: "search", ingestSource: "otlp" }),
    false,
    "a runtime's search over OTLP",
  );
  assert.equal(isOtlpLaneRow({ type: "invoke_end", ingestSource: "runtime" }), false);
});
