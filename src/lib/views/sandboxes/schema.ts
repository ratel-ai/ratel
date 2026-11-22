import { sql } from "drizzle-orm";
import {
  boolean,
  date,
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

/**
 * Agent sandbox playground (RC-1096, migration 0111). The web app and the runner
 * gateway (`apps/gateway`) share these tables; LISTEN/NOTIFY only wakes a reader
 * up. Owner ids are the identity provider's user ids (`SessionUser.externalId`). The store is
 * `lib/views/sandboxes/adapters/pg-store.ts`.
 *
 * Owned fragment of the upstream schema (ADR-0030): the sandboxes partition of the upstream schema
 * hub, column for column (upstream migrations 0111 and 0113, core migration 0045).
 */

/** One `ratel sandbox dev` instance of a project owner. `gateway_id` is null while it is offline. */
export const sandboxRunners = pgTable(
  "sandbox_runners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    // `register.runner.instanceId`: stable across reconnects of one runner.
    instanceId: text("instance_id").notNull(),
    gatewayId: text("gateway_id"),
    connectionId: text("connection_id"),
    // sandbox/v1 manifest as the runner last sent it.
    manifest: jsonb("manifest").notNull().default(sql`'{}'::jsonb`),
    // Callable providers: names and key variable names only, never values.
    providers: jsonb("providers").notNull().default(sql`'[]'::jsonb`),
    build: jsonb("build"),
    maxConcurrency: integer("max_concurrency").notNull().default(1),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sandbox_runners_instance_idx").on(t.projectId, t.ownerUserId, t.instanceId),
    index("sandbox_runners_gateway_idx").on(t.gatewayId).where(sql`${t.gatewayId} IS NOT NULL`),
  ],
);

export type SandboxRunnerRow = typeof sandboxRunners.$inferSelect;

/** A playground session: runs of one sandbox by one owner, kept on that owner's runner. */
export const sandboxSessions = pgTable(
  "sandbox_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sandboxId: text("sandbox_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    runnerId: uuid("runner_id").references(() => sandboxRunners.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    // RC-1107: the state ledger every generated fake of the session reads and replaces.
    fakeState: jsonb("fake_state").$type<Record<string, unknown>>(),
  },
  (t) => [index("sandbox_sessions_project_sandbox_idx").on(t.projectId, t.sandboxId, t.createdAt)],
);

export type SandboxSessionRow = typeof sandboxSessions.$inferSelect;

/** One run of a sandbox. `acked_seq` is the highest seq stored with no gap before it. */
export const sandboxRuns = pgTable(
  "sandbox_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sandboxId: text("sandbox_id").notNull(),
    sessionId: uuid("session_id").references(() => sandboxSessions.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    runnerId: uuid("runner_id").references(() => sandboxRunners.id, { onDelete: "set null" }),
    // SandboxRunStatus in lib/views/sandboxes/domain/run.ts.
    status: text("status").notNull().default("queued"),
    configHash: text("config_hash").notNull(),
    input: jsonb("input").notNull(),
    params: jsonb("params").notNull().default(sql`'{}'::jsonb`),
    toolModes: jsonb("tool_modes").notNull().default(sql`'{}'::jsonb`),
    context: jsonb("context").notNull().default(sql`'{}'::jsonb`),
    overrides: text("overrides").array().notNull().default(sql`'{}'::text[]`),
    output: jsonb("output"),
    error: jsonb("error"),
    usage: jsonb("usage"),
    traceId: text("trace_id"),
    ackedSeq: integer("acked_seq").notNull().default(0),
    leaseAt: timestamp("lease_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("sandbox_runs_project_sandbox_idx").on(t.projectId, t.sandboxId, t.createdAt),
    index("sandbox_runs_session_idx").on(t.sessionId, t.createdAt),
    index("sandbox_runs_live_lease_idx")
      .on(t.leaseAt)
      .where(sql`${t.status} IN ('queued', 'running')`),
    index("sandbox_runs_ended_idx").on(t.endedAt).where(sql`${t.endedAt} IS NOT NULL`),
  ],
);

export type SandboxRunRow = typeof sandboxRuns.$inferSelect;

/** One streamed event of a run (`run.event` or `run.end`), deduped on (run_id, seq). */
export const sandboxRunEvents = pgTable(
  "sandbox_run_events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => sandboxRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "sandbox_run_events_pk", columns: [t.runId, t.seq] })],
);

export type SandboxRunEventRow = typeof sandboxRunEvents.$inferSelect;

/** A command from the web app to one gateway. The gateway reads the unacked ones on every wake-up. */
export const sandboxCommands = pgTable(
  "sandbox_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gatewayId: text("gateway_id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => sandboxRuns.id, { onDelete: "cascade" }),
    // SandboxCommandKind in lib/views/sandboxes/domain/command.ts.
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
  },
  (t) => [
    index("sandbox_commands_unacked_idx")
      .on(t.gatewayId, t.createdAt)
      .where(sql`${t.ackedAt} IS NULL`),
    index("sandbox_commands_run_idx").on(t.runId),
  ],
);

export type SandboxCommandRow = typeof sandboxCommands.$inferSelect;

/** RC-1107: a fake value the reviewer pinned for one tool and one set of normalized arguments in a session. */
export const sandboxFakePins = pgTable(
  "sandbox_fake_pins",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sandboxSessions.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    // Canonical JSON of the arguments (keys sorted): lib/views/sandboxes/fakes/domain/fake.ts `argsKey`.
    argsKey: text("args_key").notNull(),
    result: jsonb("result"),
    isError: boolean("is_error").notNull().default(false),
    pinnedBy: text("pinned_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "sandbox_fake_pins_pk", columns: [t.sessionId, t.tool, t.argsKey] })],
);

/** RC-1107: generated fakes per project per UTC day, for the silent abuse guard. */
export const sandboxFakeUsage = pgTable(
  "sandbox_fake_usage",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    generated: integer("generated").notNull().default(0),
  },
  (t) => [primaryKey({ name: "sandbox_fake_usage_pk", columns: [t.projectId, t.day] })],
);
