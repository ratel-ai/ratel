import { z } from "zod";
import type { FlagSubject } from "@/lib/contracts/feature-flags";
import type { PushedCommitInput } from "./store";

/**
 * Build path B, the first one (decided 2026-11-27): the customer's CI (a GitHub Actions workflow)
 * runs `ratel push --ci` on each commit. Next to today's `git: { commit, dirty }`, the push says
 * which repository, branch and pull request the commit is on, what it compares against, and sends
 * the diff (`git.diff`, `git diff base...head`), so no GitHub App is needed to know what changed.
 * GitHub gives no secrets to a fork's workflow, so a fork cannot push: forks stay out on their own.
 *
 * The push API (the eval core's `POST /api/v1/sandboxes/versions`) calls `recordPush` once the
 * version exists; it never fails the push.
 */

const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** The git details `ratel push` sends from CI; the first two are what it sends today. */
export const pushedGitSchema = z.object({
  commit: sha,
  dirty: z.boolean(),
  repository: z.object({ id: z.number().int().positive(), fullName: z.string().min(1).max(200) }),
  branch: z.string().min(1).max(255),
  pullRequest: z.number().int().positive().nullish(),
  baseCommit: sha.nullish(),
  title: z.string().max(10_000).optional(),
  author: z.string().max(100).nullish(),
  /** `git diff <base>...<commit>`; the server keeps it up to `MAX_DIFF_BYTES`. */
  diff: z.string().optional(),
  /** The CLI left the diff out: it was over its cap. */
  diffTruncated: z.boolean().optional(),
});

/** A diff over this is not kept: the commit runs every eval. */
export const MAX_DIFF_BYTES = 1_048_576;

export type PushDeps = {
  enabled(subject: FlagSubject): Promise<boolean>;
  recordPushedCommit(input: PushedCommitInput): Promise<{ id: string }>;
};

export type PushInput = {
  organizationId: string;
  projectId: string;
  versionId: string;
  /** The push body's `git`, as sent, with its diff. */
  git: unknown;
};

export type PushResult = { recorded: true; commitId: string } | { recorded: false; reason: string };

export async function recordPush(input: PushInput, deps: PushDeps): Promise<PushResult> {
  const subject = { organizationId: input.organizationId, projectId: input.projectId };
  if (!(await deps.enabled(subject).catch(() => false))) {
    return { recorded: false, reason: "flag off" };
  }
  if (!input.git || typeof input.git !== "object" || !("repository" in input.git)) {
    return { recorded: false, reason: "no repository" };
  }
  const parsed = pushedGitSchema.safeParse(input.git);
  if (!parsed.success) return { recorded: false, reason: "invalid git details" };
  const git = parsed.data;
  if (git.dirty) return { recorded: false, reason: "uncommitted changes" };

  const diff = git.diff ?? null;
  const tooLarge = diff !== null && Buffer.byteLength(diff) > MAX_DIFF_BYTES;
  const { id } = await deps.recordPushedCommit({
    projectId: input.projectId,
    repositoryId: git.repository.id,
    sha: git.commit,
    baseSha: git.baseCommit ?? null,
    branch: git.branch,
    pullRequest: git.pullRequest ?? null,
    title: (git.title ?? "").split("\n", 1)[0].slice(0, 200),
    author: git.author ?? null,
    sandboxVersionId: input.versionId,
    diff: tooLarge ? null : diff,
    diffTruncated: tooLarge || git.diffTruncated === true,
  });
  return { recorded: true, commitId: id };
}
