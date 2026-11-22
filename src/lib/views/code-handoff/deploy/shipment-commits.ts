import { and, desc, eq, lte, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { type RepoCommitRow, type RepoLinkRow, repoCommits } from "@/lib/views/code-handoff/schema";
import { type CodeHandoffDb, getRepoLink } from "../store";

/**
 * The commits Ship shows next to a shipment recorded from GitHub (RC-921):
 * the commits that carried its fix and the recent commits of the linked repo
 * up to the deploy. A shipment no commit carried (Mark as shipped, MCP) has
 * none, and Ship shows it as before.
 */

export interface ShipmentCommit {
  sha: string;
  shortSha: string;
  messageHead: string;
  authorLogin: string | null;
  /** ISO time the commit was made. */
  pushedAt: string;
  /** `https://github.com/<owner>/<name>/commit/<sha>`. */
  url: string;
  /** True for a commit whose `ratel-fix:` marker made this shipment. */
  carried: boolean;
}

export interface ShipmentCommitsView {
  shipmentId: string;
  repo: { fullName: string; url: string };
  /** Newest first. */
  commits: ShipmentCommit[];
}

/** The recent commits of the link shown, at most. */
export const RECENT_COMMITS = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadShipmentCommits(
  projectId: string,
  shipmentId: string,
  db: CodeHandoffDb = getDb(),
): Promise<ShipmentCommitsView | null> {
  if (!UUID.test(shipmentId)) return null;
  const link = await getRepoLink(projectId, db);
  if (!link) return null;
  const carried = await db
    .select()
    .from(repoCommits)
    .where(
      and(
        eq(repoCommits.repoLinkId, link.id),
        sql`${repoCommits.shipmentIds} @> array[${shipmentId}]::uuid[]`,
      ),
    );
  if (carried.length === 0) return null;
  const upTo = Math.max(...carried.map((row) => row.seq));
  const recent = await db
    .select()
    .from(repoCommits)
    .where(and(eq(repoCommits.repoLinkId, link.id), lte(repoCommits.seq, upTo)))
    .orderBy(desc(repoCommits.seq))
    .limit(RECENT_COMMITS);
  return shipmentCommitsView(link, shipmentId, carried, recent);
}

/** The view of one shipment's commits: the carried ones and the recent ones, once each, newest first. */
export function shipmentCommitsView(
  link: Pick<RepoLinkRow, "owner" | "name">,
  shipmentId: string,
  carried: readonly RepoCommitRow[],
  recent: readonly RepoCommitRow[],
): ShipmentCommitsView {
  const repoUrl = `https://github.com/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.name)}`;
  const carriedShas = new Set(carried.map((row) => row.sha));
  const bySha = new Map<string, RepoCommitRow>();
  for (const row of [...carried, ...recent]) bySha.set(row.sha, row);
  const commits = [...bySha.values()]
    .sort((a, b) => b.seq - a.seq)
    .map((row) => ({
      sha: row.sha,
      shortSha: row.sha.slice(0, 7),
      messageHead: row.messageHead,
      authorLogin: row.authorLogin,
      pushedAt: row.pushedAt.toISOString(),
      url: `${repoUrl}/commit/${encodeURIComponent(row.sha)}`,
      carried: carriedShas.has(row.sha),
    }));
  return { shipmentId, repo: { fullName: `${link.owner}/${link.name}`, url: repoUrl }, commits };
}
