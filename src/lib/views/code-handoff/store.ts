import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import {
  type FixHandoffRow,
  fixHandoffs,
  type RepoCodePointerKind,
  type RepoCodePointerRow,
  type RepoCommitRow,
  type RepoLinkRow,
  repoCodePointers,
  repoCommits,
  repoLinks,
} from "@/lib/views/code-handoff/schema";

/**
 * Code handoff's tables (RC-862): the repo linked to a project, its pushed
 * commits, code pointers into it and the fixes handed off.
 */

export type CodeHandoffDb = Pick<
  ReturnType<typeof getDb>,
  "select" | "insert" | "update" | "delete"
>;

export interface NewRepoLink {
  projectId: string;
  installationId: number;
  repoId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  linkedBy: string;
}

export interface NewRepoCommit {
  sha: string;
  message: string;
  authorLogin: string | null;
  pushedAt: Date;
  seq: number;
  fixIds: string[];
}

export interface NewCodePointer {
  kind: RepoCodePointerKind;
  symbol: string;
  path: string;
  line: number | null;
}

export interface NewFixHandoff {
  projectId: string;
  fixId: string;
  target: string;
  externalId: string;
  url: string;
  handedOffBy: string;
}

/** The first line of a commit message, capped at this many characters. */
export const MESSAGE_HEAD_MAX = 200;

/** Link a repo to a project, replacing any repo it was linked to. */
export async function linkRepo(
  link: NewRepoLink,
  db: CodeHandoffDb = getDb(),
): Promise<RepoLinkRow> {
  const [row] = await db
    .insert(repoLinks)
    .values(link)
    .onConflictDoUpdate({
      target: repoLinks.projectId,
      set: {
        installationId: link.installationId,
        repoId: link.repoId,
        owner: link.owner,
        name: link.name,
        defaultBranch: link.defaultBranch,
        linkedBy: link.linkedBy,
        createdAt: sql`now()`,
      },
    })
    .returning();
  return row;
}

export async function getRepoLink(
  projectId: string,
  db: CodeHandoffDb = getDb(),
): Promise<RepoLinkRow | null> {
  const [row] = await db
    .select()
    .from(repoLinks)
    .where(eq(repoLinks.projectId, projectId))
    .limit(1);
  return row ?? null;
}

/** Every link of one repo (several projects may link the same repo). */
export function listRepoLinksByRepo(
  repoId: number,
  db: CodeHandoffDb = getDb(),
): Promise<RepoLinkRow[]> {
  return db.select().from(repoLinks).where(eq(repoLinks.repoId, repoId));
}

/** Remove a project's link. True when there was one. */
export async function unlinkRepo(projectId: string, db: CodeHandoffDb = getDb()): Promise<boolean> {
  const removed = await db
    .delete(repoLinks)
    .where(eq(repoLinks.projectId, projectId))
    .returning({ id: repoLinks.id });
  return removed.length > 0;
}

/** Every link made through one installation of the App. */
export function listRepoLinksByInstallation(
  installationId: number,
  db: CodeHandoffDb = getDb(),
): Promise<RepoLinkRow[]> {
  return db.select().from(repoLinks).where(eq(repoLinks.installationId, installationId));
}

/** Delete links by id. Returns how many went. */
export async function deleteRepoLinks(
  linkIds: string[],
  db: CodeHandoffDb = getDb(),
): Promise<number> {
  if (linkIds.length === 0) return 0;
  const removed = await db
    .delete(repoLinks)
    .where(inArray(repoLinks.id, linkIds))
    .returning({ id: repoLinks.id });
  return removed.length;
}

/** Record pushed commits; a commit already recorded for the link is kept as it was. */
export async function recordRepoCommits(
  repoLinkId: string,
  commits: NewRepoCommit[],
  db: CodeHandoffDb = getDb(),
): Promise<number> {
  if (commits.length === 0) return 0;
  const inserted = await db
    .insert(repoCommits)
    .values(
      commits.map((commit) => ({
        repoLinkId,
        sha: commit.sha,
        messageHead: messageHead(commit.message),
        authorLogin: commit.authorLogin,
        pushedAt: commit.pushedAt,
        seq: commit.seq,
        fixIds: commit.fixIds,
      })),
    )
    .onConflictDoNothing({ target: [repoCommits.repoLinkId, repoCommits.sha] })
    .returning({ id: repoCommits.id });
  return inserted.length;
}

/** A link's commits in push order. */
export function listRepoCommits(
  repoLinkId: string,
  db: CodeHandoffDb = getDb(),
): Promise<RepoCommitRow[]> {
  return db
    .select()
    .from(repoCommits)
    .where(eq(repoCommits.repoLinkId, repoLinkId))
    .orderBy(asc(repoCommits.seq));
}

/** Mark commits deployed and attach the shipments the deploy made. */
export async function markCommitsDeployed(
  repoLinkId: string,
  shas: string[],
  deployedAt: Date,
  shipmentIds: string[],
  db: CodeHandoffDb = getDb(),
): Promise<void> {
  if (shas.length === 0) return;
  await db
    .update(repoCommits)
    .set({ deployedAt, shipmentIds })
    .where(and(eq(repoCommits.repoLinkId, repoLinkId), inArray(repoCommits.sha, shas)));
}

/** Replace a link's code pointers with a fresh index. */
export async function replaceCodePointers(
  repoLinkId: string,
  pointers: NewCodePointer[],
  db: CodeHandoffDb = getDb(),
): Promise<void> {
  await db.delete(repoCodePointers).where(eq(repoCodePointers.repoLinkId, repoLinkId));
  if (pointers.length === 0) return;
  await db.insert(repoCodePointers).values(pointers.map((pointer) => ({ repoLinkId, ...pointer })));
}

export function listCodePointers(
  repoLinkId: string,
  db: CodeHandoffDb = getDb(),
): Promise<RepoCodePointerRow[]> {
  return db
    .select()
    .from(repoCodePointers)
    .where(eq(repoCodePointers.repoLinkId, repoLinkId))
    .orderBy(asc(repoCodePointers.kind), asc(repoCodePointers.symbol), asc(repoCodePointers.path));
}

/** Record a handoff once per fix and target; a second one returns the first. */
export async function recordFixHandoff(
  handoff: NewFixHandoff,
  db: CodeHandoffDb = getDb(),
): Promise<FixHandoffRow> {
  const [inserted] = await db
    .insert(fixHandoffs)
    .values(handoff)
    .onConflictDoNothing({ target: [fixHandoffs.projectId, fixHandoffs.fixId, fixHandoffs.target] })
    .returning();
  if (inserted) return inserted;
  const existing = await getFixHandoff(handoff.projectId, handoff.fixId, handoff.target, db);
  if (!existing) throw new Error("fix handoff conflict without a row");
  return existing;
}

export async function getFixHandoff(
  projectId: string,
  fixId: string,
  target: string,
  db: CodeHandoffDb = getDb(),
): Promise<FixHandoffRow | null> {
  const [row] = await db
    .select()
    .from(fixHandoffs)
    .where(
      and(
        eq(fixHandoffs.projectId, projectId),
        eq(fixHandoffs.fixId, fixId),
        eq(fixHandoffs.target, target),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The first line of a commit message, at most `MESSAGE_HEAD_MAX` characters. */
export function messageHead(message: string): string {
  return (message.split(/\r?\n/, 1)[0] ?? "").slice(0, MESSAGE_HEAD_MAX);
}
