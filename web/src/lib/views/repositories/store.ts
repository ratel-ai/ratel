import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";
import {
  type CommitStatus,
  type ProjectRepositoryRow,
  projectRepositories,
  type RepositoryCommitRow,
  repositoryCommits,
} from "./schema";

export type RepositoryDb = Pick<
  ReturnType<typeof getDb>,
  "select" | "insert" | "update" | "delete"
>;

export type LinkInput = {
  projectId: string;
  repositoryId: number;
  fullName: string;
  installationId: number | null;
  defaultBranch: string;
  versionBranches?: string[];
  pullRequests?: boolean;
  configPath?: string;
  linkedBy: string;
};

/** Links a repository to a project, or updates the link it has (keeping when it was linked). */
export async function linkRepository(input: LinkInput, db: RepositoryDb = getDb()): Promise<void> {
  const values = {
    provider: "github",
    repositoryId: input.repositoryId,
    fullName: input.fullName,
    installationId: input.installationId,
    defaultBranch: input.defaultBranch,
    versionBranches: input.versionBranches ?? [],
    pullRequests: input.pullRequests ?? true,
    configPath: input.configPath ?? "ratel.yaml",
    linkedBy: input.linkedBy,
  };
  await db
    .insert(projectRepositories)
    .values({ projectId: input.projectId, ...values })
    .onConflictDoUpdate({
      target: [
        projectRepositories.projectId,
        projectRepositories.provider,
        projectRepositories.repositoryId,
      ],
      set: values,
    });
}

/** Unlinks one repository. Its commits stay: they are the project's version history. */
export async function unlinkRepository(
  projectId: string,
  repositoryId: number,
  db: RepositoryDb = getDb(),
): Promise<void> {
  await db
    .delete(projectRepositories)
    .where(
      and(
        eq(projectRepositories.projectId, projectId),
        eq(projectRepositories.provider, "github"),
        eq(projectRepositories.repositoryId, repositoryId),
      ),
    );
}

/** A project's linked repositories, in the order they were linked. */
export async function listRepositoryLinks(
  projectId: string,
  db: RepositoryDb = getDb(),
): Promise<ProjectRepositoryRow[]> {
  return db
    .select()
    .from(projectRepositories)
    .where(eq(projectRepositories.projectId, projectId))
    .orderBy(asc(projectRepositories.linkedAt), asc(projectRepositories.repositoryId));
}

export type RepositoryLink = ProjectRepositoryRow & { organizationId: string };

/** Every project that links this GitHub repository, with its organization (for the flag). */
export async function linksForRepository(
  repositoryId: number,
  db: RepositoryDb = getDb(),
): Promise<RepositoryLink[]> {
  const rows = await db
    .select({ link: projectRepositories, organizationId: projects.organizationId })
    .from(projectRepositories)
    .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
    .where(
      and(
        eq(projectRepositories.provider, "github"),
        eq(projectRepositories.repositoryId, repositoryId),
      ),
    );
  return rows.map(({ link, organizationId }) => ({ ...link, organizationId }));
}

export type CommitInput = Pick<
  RepositoryCommitRow,
  | "projectId"
  | "repositoryId"
  | "sha"
  | "baseSha"
  | "branch"
  | "pullRequest"
  | "title"
  | "author"
  | "reason"
> & { status: CommitStatus };

/**
 * Records a commit once per project. A redelivery, or a pull request that names a commit a push
 * already recorded, changes nothing but the pull request number: never the status.
 */
export async function recordCommit(
  input: CommitInput,
  db: RepositoryDb = getDb(),
): Promise<{ id: string; created: boolean }> {
  const [inserted] = await db
    .insert(repositoryCommits)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: repositoryCommits.id });
  if (inserted) return { id: inserted.id, created: true };

  const [existing] = await db
    .update(repositoryCommits)
    .set({
      pullRequest: sql`coalesce(${repositoryCommits.pullRequest}, ${input.pullRequest})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(repositoryCommits.projectId, input.projectId),
        eq(repositoryCommits.repositoryId, input.repositoryId),
        eq(repositoryCommits.sha, input.sha),
      ),
    )
    .returning({ id: repositoryCommits.id });
  return { id: existing.id, created: false };
}

/** The builder's side: where a commit stands, and the version it built. */
export async function markCommit(
  id: string,
  change: { status: CommitStatus; reason?: string | null; sandboxVersionId?: string | null },
  db: RepositoryDb = getDb(),
): Promise<void> {
  await db
    .update(repositoryCommits)
    .set({ ...change, updatedAt: new Date() })
    .where(eq(repositoryCommits.id, id));
}

export async function listCommits(
  projectId: string,
  limit: number,
  db: RepositoryDb = getDb(),
): Promise<RepositoryCommitRow[]> {
  return db
    .select()
    .from(repositoryCommits)
    .where(eq(repositoryCommits.projectId, projectId))
    .orderBy(desc(repositoryCommits.receivedAt), desc(repositoryCommits.id))
    .limit(limit);
}
