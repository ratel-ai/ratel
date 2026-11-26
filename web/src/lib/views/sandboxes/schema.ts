import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import type { RatelYaml } from "./domain/config";
import type { RunInput, RunResult } from "./domain/run";
import type { SmokeResult } from "./domain/smoke";

/** The tables of Ratel sandboxes (the `sandboxes` flag). */

/** A sandbox: the name that the pushes of a project share. */
export const sandboxes = pgTable(
  "sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sandboxes_project_name_idx").on(t.projectId, t.name)],
);

/**
 * One push of an image. Only the preparation columns (status, reason, snapshot, smoke, log, build
 * times) change after it.
 */
export const sandboxVersions = pgTable(
  "sandbox_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => sandboxes.id, { onDelete: "cascade" }),
    // The parsed ratel.yaml (`ratel-yaml.schema.json`).
    config: jsonb("config").$type<RatelYaml>().notNull(),
    // The image id that the push named (`sha256:...`) and its platform. Null before images.
    imageDigest: text("image_digest"),
    imagePlatform: text("image_platform"),
    // Null when the push had no git information.
    gitCommit: text("git_commit"),
    gitDirty: boolean("git_dirty"),
    bundleSha256: text("bundle_sha256").notNull(),
    bundleBytes: bigint("bundle_bytes", { mode: "number" }).notNull(),
    // The key that pushed. No foreign key: a deleted key must not change a version.
    apiKeyId: uuid("api_key_id"),
    // "uploading" | "uploaded" | "preparing" | "ready" | "failed"
    status: text("status").notNull().default("uploading"),
    reason: text("reason"),
    // The name of the snapshot that holds the loaded image.
    imageRef: text("image_ref"),
    // The smoke check (`version.schema.json#/$defs/smoke`).
    smoke: jsonb("smoke").$type<SmokeResult>(),
    buildLog: text("build_log"),
    buildStartedAt: timestamp("build_started_at", { withTimezone: true }),
    buildHeartbeatAt: timestamp("build_heartbeat_at", { withTimezone: true }),
    buildFinishedAt: timestamp("build_finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sandbox_versions_project_created_idx").on(t.projectId, t.createdAt),
    index("sandbox_versions_sandbox_created_idx").on(t.sandboxId, t.createdAt),
  ],
);

/** The secrets of a project's sandboxes. The value is sealed (`lib/platform/sealed-secrets.ts`). */
export const sandboxSecrets = pgTable(
  "sandbox_secrets",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sealedValue: text("sealed_value").notNull(),
    // The identity provider's user id.
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.name] })],
);

/** One run of a version in one new instance. */
export const sandboxRuns = pgTable(
  "sandbox_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => sandboxVersions.id, { onDelete: "cascade" }),
    // `run-input.schema.json`: the input, the params, the tool policy and the fixtures.
    runInput: jsonb("run_input").$type<RunInput>().notNull(),
    // "queued" | "running" | "completed" | "failed" | "infra_error" | "timed_out"
    status: text("status").notNull().default("queued"),
    // `run-result.schema.json`, as the runner posted it.
    result: jsonb("result").$type<RunResult>(),
    // Why a run has no result.
    reason: text("reason"),
    traceId: text("trace_id"),
    // SHA-256 of the run token.
    tokenHash: text("token_hash").notNull(),
    instanceRef: text("instance_ref"),
    timeoutS: integer("timeout_s").notNull(),
    // Who or what started it.
    requestedBy: text("requested_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    instanceStoppedAt: timestamp("instance_stopped_at", { withTimezone: true }),
    usageRecordedAt: timestamp("usage_recorded_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sandbox_runs_token_hash_idx").on(t.tokenHash),
    index("sandbox_runs_project_created_idx").on(t.projectId, t.createdAt),
    index("sandbox_runs_version_created_idx").on(t.versionId, t.createdAt),
    // The sweep reads the runs that still have work; a finished run leaves the index.
    index("sandbox_runs_open_idx")
      .on(t.createdAt)
      .where(
        sql`${t.status} in ('queued', 'running') or (${t.instanceRef} is not null and (${t.instanceStoppedAt} is null or ${t.usageRecordedAt} is null))`,
      ),
  ],
);

/**
 * The instances that were started and not stopped. It has no foreign key and no customer data: the
 * delete of a project removes its runs, and the sweep must still stop their instances.
 */
export const sandboxInstances = pgTable("sandbox_instances", {
  runId: uuid("run_id").primaryKey(),
  projectId: uuid("project_id").notNull(),
  instanceRef: text("instance_ref").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
});
