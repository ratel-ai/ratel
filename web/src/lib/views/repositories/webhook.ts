import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { matchesBranch } from "./glob";

/**
 * GitHub's side of a repository link: is a delivery GitHub's, which commit it names, and whether
 * that commit makes a version. Pure; `receive.ts` puts it together with the store.
 */

/** `X-Hub-Signature-256`: the body's HMAC-SHA256 under the webhook secret, compared in constant time. */
export function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** One commit that may make a version. */
export type CommitEvent = {
  kind: "push" | "pull_request";
  repositoryId: number;
  fullName: string;
  installationId: number | null;
  sha: string;
  /** What the change compares against: the branch's previous head, or the pull request's base. */
  baseSha: string | null;
  branch: string;
  pullRequest: number | null;
  fromFork: boolean;
  /** The commit's first line, or the pull request's title. */
  title: string;
  author: string | null;
};

export type ParsedEvent = CommitEvent | { ignored: string };

const ZERO_SHA = /^0{40}$/;
const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

const repository = z.object({ id: z.number(), full_name: z.string() });
const installation = z.object({ id: z.number() }).nullish();

const pushPayload = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  deleted: z.boolean().optional(),
  repository,
  installation,
  head_commit: z
    .object({
      id: z.string(),
      message: z.string(),
      author: z.object({ username: z.string().optional() }).nullish(),
    })
    .nullable(),
});

const pullRequestPayload = z.object({
  action: z.string(),
  number: z.number(),
  repository,
  installation,
  pull_request: z.object({
    title: z.string(),
    user: z.object({ login: z.string() }).nullish(),
    head: z.object({
      sha: z.string(),
      ref: z.string(),
      repo: z.object({ id: z.number() }).nullable(),
    }),
    base: z.object({ sha: z.string(), ref: z.string(), repo: z.object({ id: z.number() }) }),
  }),
});

/** The commit a `push` or `pull_request` delivery names; anything else is ignored, with why. */
export function parseGitHubEvent(name: string, payload: unknown): ParsedEvent {
  if (name === "ping") return { ignored: "ping" };
  if (name === "push") {
    const parsed = pushPayload.safeParse(payload);
    if (!parsed.success) return { ignored: "unreadable payload" };
    const push = parsed.data;
    if (!push.ref.startsWith("refs/heads/")) return { ignored: "not a branch" };
    if (push.deleted || ZERO_SHA.test(push.after)) return { ignored: "branch deleted" };
    if (!push.head_commit) return { ignored: "no commit" };
    return {
      kind: "push",
      repositoryId: push.repository.id,
      fullName: push.repository.full_name,
      installationId: push.installation?.id ?? null,
      sha: push.after,
      baseSha: ZERO_SHA.test(push.before) ? null : push.before,
      branch: push.ref.slice("refs/heads/".length),
      pullRequest: null,
      fromFork: false,
      title: firstLine(push.head_commit.message),
      author: push.head_commit.author?.username ?? null,
    };
  }
  if (name === "pull_request") {
    const parsed = pullRequestPayload.safeParse(payload);
    if (!parsed.success) return { ignored: "unreadable payload" };
    const { action, number, pull_request: pr, ...rest } = parsed.data;
    if (!PR_ACTIONS.has(action)) return { ignored: `pull request ${action}` };
    return {
      kind: "pull_request",
      repositoryId: rest.repository.id,
      fullName: rest.repository.full_name,
      installationId: rest.installation?.id ?? null,
      sha: pr.head.sha,
      baseSha: pr.base.sha,
      branch: pr.head.ref,
      pullRequest: number,
      // A deleted fork has no head repository: still a fork.
      fromFork: pr.head.repo?.id !== pr.base.repo.id,
      title: firstLine(pr.title),
      author: pr.user?.login ?? null,
    };
  }
  return { ignored: `event ${name}` };
}

const firstLine = (text: string) => text.split("\n", 1)[0].slice(0, 200);

/** What a project's link says about which commits make versions. */
export type VersionPolicy = {
  defaultBranch: string;
  /** More branch patterns than the default branch (`release/*`). */
  versionBranches: string[];
  pullRequests: boolean;
};

export type CommitDecision =
  | { action: "build" }
  | { action: "skip"; reason: string }
  | { action: "await_approval"; reason: string };

/**
 * Whether a commit makes a version: the default branch and the listed patterns do; a pull request
 * does when the link takes them, and from a fork only once an admin approves (its code would run
 * with the project's sandbox secrets).
 */
export function decideCommit(policy: VersionPolicy, event: CommitEvent): CommitDecision {
  if (event.kind === "pull_request") {
    if (!policy.pullRequests) {
      return { action: "skip", reason: "pull requests make no versions for this project" };
    }
    if (event.fromFork) {
      return {
        action: "await_approval",
        reason: "a pull request from a fork runs only once an admin approves it",
      };
    }
    return { action: "build" };
  }
  const watched = [policy.defaultBranch, ...policy.versionBranches];
  if (watched.some((pattern) => matchesBranch(pattern, event.branch))) return { action: "build" };
  return { action: "skip", reason: `branch ${event.branch} makes no versions` };
}
