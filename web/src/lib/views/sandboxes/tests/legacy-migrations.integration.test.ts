import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { MIGRATIONS_DIR } from "@/lib/platform/db/test-support";
import { createDrizzleRunStore } from "../adapters/drizzle-run-store";
import { createDrizzleVersionStore } from "../adapters/drizzle-version-store";
import { ratelYamlSchema } from "../domain/config";
import { sandboxRunSchema, sandboxRunView } from "../domain/run";
import { versionView } from "../domain/version";
import { ORGANIZATION_ID, PROJECT_ID } from "./support";

/** The first migration of images: the rows before it are legacy rows. */
const FIRST_IMAGE_MIGRATION = "0063_";
const SANDBOX_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";
const COMPLETED_RUN_ID = "66666666-6666-4666-8666-666666666666";
const FAILED_RUN_ID = "77777777-7777-4777-8777-777777777777";

const LEGACY_COMPLETED = {
  v: 1,
  runId: COMPLETED_RUN_ID,
  status: "completed",
  output: { reply: null, total: 3 },
  toolCalls: [
    { name: "lookup_order", arguments: { id: null }, source: "real" },
    { name: "refund_order", arguments: { id: "7" }, error: "No fixture.", source: "fixture" },
    { name: "notify", arguments: { to: "a" }, result: { sent: null }, source: "fake" },
  ],
  usage: { durationMs: 1200, inputTokens: 12, outputTokens: 3, costUsd: null },
  traceId: "t1",
};
const LEGACY_FAILED = {
  v: 1,
  runId: FAILED_RUN_ID,
  status: "failed",
  toolCalls: [],
  usage: { durationMs: 40 },
  traceId: "t2",
  error: { type: "agent_error", message: "The agent broke." },
};

/** A database with the legacy rows, migrated to the last migration. */
async function migratedLegacyDb() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const client = new PGlite();
  const apply = async (file: string) =>
    client.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  for (const file of files.filter((name) => name < FIRST_IMAGE_MIGRATION)) await apply(file);
  await client.exec(`
    create table organizations (id uuid primary key, name text not null, slug text not null unique);
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
      values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
    insert into sandboxes (id, project_id, name) values ('${SANDBOX_ID}', '${PROJECT_ID}', 'support-agent');
    insert into sandbox_versions
      (id, project_id, sandbox_id, manifest, git_commit, git_dirty, bundle_sha256, bundle_bytes, status, image_ref)
      values ('${VERSION_ID}', '${PROJECT_ID}', '${SANDBOX_ID}', '${JSON.stringify({
        secrets: ["OPENAI_API_KEY"],
        tools: [
          { name: "lookup_order", sideEffect: false },
          { name: "refund_order", sideEffect: true },
        ],
      })}', '${"b".repeat(40)}', false, '${"a".repeat(64)}', 10, 'ready', 'old-image');
    insert into sandbox_runs
      (id, project_id, version_id, run_input, status, result, token_hash, timeout_s, requested_by)
      values
      ('${COMPLETED_RUN_ID}', '${PROJECT_ID}', '${VERSION_ID}', '{"input":{"message":"hi"}}',
        'completed', '${JSON.stringify(LEGACY_COMPLETED)}', 'h1', 300, 'user_1'),
      ('${FAILED_RUN_ID}', '${PROJECT_ID}', '${VERSION_ID}', '{"input":{"message":"hi"}}',
        'failed', '${JSON.stringify(LEGACY_FAILED)}', 'h2', 300, 'user_1');
  `);
  for (const file of files.filter((name) => name >= FIRST_IMAGE_MIGRATION)) await apply(file);
  // biome-ignore lint/suspicious/noExplicitAny: PGlite stands in for the Postgres client
  return drizzle(client, { schema }) as any;
}

test("a legacy version becomes a failed version with a valid ratel.yaml", async () => {
  const db = await migratedLegacyDb();
  const version = await createDrizzleVersionStore(db).get(PROJECT_ID, VERSION_ID);
  assert.ok(version);
  const view = versionView(version);
  assert.equal(view.status, "failed");
  assert.match(view.reason ?? "", /before images/);
  assert.deepEqual(view.config, {
    name: "support-agent",
    input: { example: null },
    secrets: ["OPENAI_API_KEY"],
    tools: { lookup_order: { mode: "live" }, refund_order: { mode: "simulated" } },
  });
  assert.ok(ratelYamlSchema.safeParse(view.config).success);
});

test("a legacy run result keeps its nulls inside the output, the args and the results", async () => {
  const db = await migratedLegacyDb();
  const run = await createDrizzleRunStore(db).get(PROJECT_ID, COMPLETED_RUN_ID);
  assert.ok(run);
  const view = sandboxRunView(run);
  assert.ok(sandboxRunSchema.safeParse(view).success, JSON.stringify(view));
  assert.deepEqual(view.output, { reply: null, total: 3 });
  assert.deepEqual(view.toolCalls, [
    { name: "lookup_order", args: { id: null }, mode: "live", result: null },
    {
      name: "refund_order",
      args: { id: "7" },
      mode: "recorded",
      error: { code: "tool_failed", message: "No fixture." },
    },
    { name: "notify", args: { to: "a" }, mode: "simulated", result: { sent: null } },
  ]);
  assert.deepEqual(view.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(run.durationMs, 1200);
});

test("a legacy failed run has its error, and a response the protocol accepts", async () => {
  const db = await migratedLegacyDb();
  const run = await createDrizzleRunStore(db).get(PROJECT_ID, FAILED_RUN_ID);
  assert.ok(run);
  const view = sandboxRunView(run);
  assert.ok(sandboxRunSchema.safeParse(view).success, JSON.stringify(view));
  assert.equal(view.status, "failed");
  assert.deepEqual(view.error, { code: "run_failed", message: "The agent broke." });
  assert.deepEqual(view.toolCalls, []);
  assert.equal(run.durationMs, 40);
});
