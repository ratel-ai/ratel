import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import type { SandboxManifest } from "./domain/manifest";

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

/** One push. Only the build columns (status, reason, image, log, build times) change after it. */
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
    manifest: jsonb("manifest").$type<SandboxManifest>().notNull(),
    gitCommit: text("git_commit").notNull(),
    gitDirty: boolean("git_dirty").notNull(),
    bundleSha256: text("bundle_sha256").notNull(),
    bundleBytes: bigint("bundle_bytes", { mode: "number" }).notNull(),
    // The key that pushed. No foreign key: a deleted key must not change a version.
    apiKeyId: uuid("api_key_id"),
    // "uploading" | "uploaded" | "building" | "ready" | "failed"
    status: text("status").notNull().default("uploading"),
    reason: text("reason"),
    imageRef: text("image_ref"),
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
