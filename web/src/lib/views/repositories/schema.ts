import {
  bigint,
  boolean,
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
 * A project's GitHub repository and the commits that make its versions (RTL-408, behind
 * `githubRepositories`). See `docs/github-repositories.md`.
 */

/** The one repository a project links. GitHub's repository id survives a rename; the name is for show. */
export const projectRepositories = pgTable(
  "project_repositories",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("github"),
    repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
    fullName: text("full_name").notNull(),
    // The GitHub App installation that reaches it; tokens are minted per use, never stored.
    installationId: bigint("installation_id", { mode: "number" }),
    defaultBranch: text("default_branch").notNull(),
    // Branch patterns besides the default branch whose commits make versions (`release/*`).
    versionBranches: text("version_branches").array().notNull().default([]),
    pullRequests: boolean("pull_requests").notNull().default(true),
    // Where the agent's ratel.yaml is: a monorepo may hold several agents.
    configPath: text("config_path").notNull().default("ratel.yaml"),
    linkedBy: text("linked_by").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("project_repositories_repository_idx").on(t.provider, t.repositoryId)],
);

/**
 * A commit that makes, or may make, a version: `queued` until the builder takes it,
 * `awaiting_approval` for a fork's pull request, then `building`, `ready` or `failed`. One row per
 * commit: the same code is one version, whether a push or a pull request named it.
 * `sandbox_version_id` is the version it built. No foreign key yet: `sandbox_versions` lands with
 * the eval core (RP-308), and the key comes with it.
 */
export const repositoryCommits = pgTable(
  "repository_commits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
    sha: text("sha").notNull(),
    // What the change compares against: the branch's previous head, or the pull request's base.
    baseSha: text("base_sha"),
    branch: text("branch").notNull(),
    pullRequest: integer("pull_request"),
    fromFork: boolean("from_fork").notNull().default(false),
    title: text("title").notNull(),
    author: text("author"),
    status: text("status").notNull(),
    reason: text("reason"),
    sandboxVersionId: uuid("sandbox_version_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("repository_commits_commit_idx").on(t.projectId, t.repositoryId, t.sha),
    index("repository_commits_project_received_idx").on(t.projectId, t.receivedAt),
  ],
);

export type ProjectRepositoryRow = typeof projectRepositories.$inferSelect;
export type RepositoryCommitRow = typeof repositoryCommits.$inferSelect;

export const COMMIT_STATUSES = [
  "queued",
  "awaiting_approval",
  "building",
  "ready",
  "failed",
] as const;
export type CommitStatus = (typeof COMMIT_STATUSES)[number];
