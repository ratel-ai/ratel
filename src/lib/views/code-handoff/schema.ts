import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * Code handoff (RC-862, switch `FF_CODE_HANDOFF`): the one GitHub repo a
 * project is linked to through the Ratel GitHub App. One link per project.
 */
export const repoLinks = pgTable(
  "repo_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    linkedBy: text("linked_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("repo_links_project_idx").on(t.projectId),
    index("repo_links_installation_idx").on(t.installationId),
    index("repo_links_repo_idx").on(t.repoId),
  ],
);

export type RepoLinkRow = typeof repoLinks.$inferSelect;

/**
 * A commit pushed to a linked repo's default branch, with the fixes its
 * message names (`ratel-fix: <id>`) and, once deployed, the shipments it made.
 * `seq` is the push order; `messageHead` is the first line only, capped at 200.
 */
export const repoCommits = pgTable(
  "repo_commits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoLinkId: uuid("repo_link_id")
      .notNull()
      .references(() => repoLinks.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    messageHead: text("message_head").notNull(),
    authorLogin: text("author_login"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }).notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    fixIds: text("fix_ids").array().notNull().default(sql`'{}'::text[]`),
    shipmentIds: uuid("shipment_ids").array().notNull().default(sql`'{}'::uuid[]`),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("repo_commits_link_sha_idx").on(t.repoLinkId, t.sha),
    index("repo_commits_link_seq_idx").on(t.repoLinkId, t.seq),
  ],
);

export type RepoCommitRow = typeof repoCommits.$inferSelect;

export const REPO_CODE_POINTER_KINDS = ["tool", "prompt", "model"] as const;
export type RepoCodePointerKind = (typeof REPO_CODE_POINTER_KINDS)[number];

/** Where in a linked repo a tool, a prompt or a model choice is defined. */
export const repoCodePointers = pgTable(
  "repo_code_pointers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoLinkId: uuid("repo_link_id")
      .notNull()
      .references(() => repoLinks.id, { onDelete: "cascade" }),
    kind: text("kind").$type<RepoCodePointerKind>().notNull(),
    symbol: text("symbol").notNull(),
    path: text("path").notNull(),
    line: integer("line"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("repo_code_pointers_link_symbol_idx").on(t.repoLinkId, t.kind, t.symbol),
    check("repo_code_pointers_kind_check", sql`${t.kind} in ('tool', 'prompt', 'model')`),
  ],
);

export type RepoCodePointerRow = typeof repoCodePointers.$inferSelect;

/** A fix handed off to a target (a GitHub issue for a coding agent), once per target. */
export const fixHandoffs = pgTable(
  "fix_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fixId: text("fix_id").notNull(),
    target: text("target").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    handedOffBy: text("handed_off_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("fix_handoffs_project_fix_target_idx").on(t.projectId, t.fixId, t.target)],
);

export type FixHandoffRow = typeof fixHandoffs.$inferSelect;
