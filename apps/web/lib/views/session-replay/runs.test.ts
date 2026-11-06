import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getTableColumns } from "drizzle-orm";
import { MIGRATIONS_DIR } from "@/lib/platform/db/test-support";
import { errorCodeOf } from "@/lib/views/session-replay/runs";
import { sessionReplayRuns, sessionReplaySettings } from "@/lib/views/session-replay/schema";

/** RC-176: a What-if run keeps numbers, tool names and codes only. */

const TEXT_NAMES =
  /prompt|message|argument|args|query|content_text|conversation|system|description/i;

test("the What-if tables have no prompt, message, argument or query text column", () => {
  for (const table of [sessionReplayRuns, sessionReplaySettings]) {
    for (const column of Object.values(getTableColumns(table))) {
      assert.doesNotMatch(column.name, TEXT_NAMES, `${column.name} reads like stored content`);
    }
  }
});

test("the session_replay_runs migration only creates tables and their indexes and keys", () => {
  // Owned (ADR-0030): this repository's migration, whatever its number; upstream reads its 0083.
  const file = readdirSync(MIGRATIONS_DIR).find((name) =>
    name.endsWith("_session_replay_runs.sql"),
  );
  assert.ok(file, "no session_replay_runs migration");
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const statement of statements) {
    assert.match(
      statement,
      /^(CREATE TABLE "session_replay_|CREATE (UNIQUE )?INDEX "session_replay_|ALTER TABLE "session_replay_\w+" ADD CONSTRAINT)/,
      statement.slice(0, 80),
    );
  }
});

test("a failure reason is stored as a code, never the words", () => {
  assert.equal(errorCodeOf("The replay budget ran out before this run"), "budget");
  assert.equal(
    errorCodeOf("Needs stored prompts: this run's model calls weren't captured"),
    "noPrompts",
  );
  assert.equal(errorCodeOf("anything else"), "failed");
});
