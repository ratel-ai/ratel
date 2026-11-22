import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoCommitRow, RepoLinkRow } from "@/lib/views/code-handoff/schema";
import { signWebhookBody } from "../github/webhook-signature";
import {
  createGitHubWebhookHandler,
  GITHUB_EVENT_HANDLERS,
  type GitHubWebhookDeps,
} from "../webhook-handler";
import {
  type DetectByVersionDeps,
  detectDeploysByVersion,
  shaCandidates,
  VERSION_LOOKBACK_MAX_MS,
} from "./detect-by-version";
import { createDeploymentStatusHandler } from "./on-deployment-status";

/** The two deploy signals (RC-920): their gates and what they pass to `recordDeploy`. */

const SECRET = "test-webhook-secret";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const SHA = "c".repeat(40);
const LINK: RepoLinkRow = {
  id: "link-1",
  projectId: PROJECT,
  installationId: 9,
  repoId: 501,
  owner: "acme",
  name: "agent",
  defaultBranch: "main",
  linkedBy: "user_a",
  createdAt: new Date(0),
};

function webhook(options: { flagOff?: boolean } = {}) {
  const deploys: [string, string][] = [];
  const deps: GitHubWebhookDeps = {
    webhookSecret: () => SECRET,
    flagEnabledForProject: async () => !options.flagOff,
    listRepoLinksByInstallation: async () => [],
    deleteRepoLinks: async () => 0,
  };
  const deploymentStatus = createDeploymentStatusHandler({
    listRepoLinksByRepo: async (repoId) => (repoId === LINK.repoId ? [LINK] : []),
    recordDeploy: async (link, sha) => {
      deploys.push([link.id, sha]);
      return { shipped: 1, commits: 1 };
    },
  });
  const handler = createGitHubWebhookHandler(deps, {
    ...GITHUB_EVENT_HANDLERS,
    deployment_status: deploymentStatus,
  });
  return { handler, deploys };
}

function deploymentStatus(state: string, overrides: Record<string, unknown> = {}): Request {
  const body = JSON.stringify({
    action: "created",
    deployment_status: { state },
    deployment: { sha: SHA, environment: "production" },
    repository: { id: 501 },
    installation: { id: 9 },
    ...overrides,
  });
  return new Request("http://localhost/api/github/webhook", {
    method: "POST",
    body,
    headers: {
      "x-github-event": "deployment_status",
      "x-hub-signature-256": signWebhookBody(body, SECRET),
    },
  });
}

test("deployment_status success records the deploy of its sha", async () => {
  const { handler, deploys } = webhook();
  const response = await handler(deploymentStatus("success"));
  assert.deepEqual(await response.json(), { removed: 0, shipped: 1 });
  assert.deepEqual(deploys, [["link-1", SHA]]);
});

test("deployment_status with another state records nothing", async () => {
  const { handler, deploys } = webhook();
  for (const state of ["pending", "in_progress", "failure", "error", "inactive"]) {
    assert.deepEqual(await (await handler(deploymentStatus(state))).json(), {
      removed: 0,
      shipped: 0,
    });
  }
  assert.deepEqual(deploys, []);
});

test("deployment_status: flag off records nothing", async () => {
  const { handler, deploys } = webhook({ flagOff: true });
  assert.deepEqual(await (await handler(deploymentStatus("success"))).json(), {
    removed: 0,
    shipped: 0,
  });
  assert.deepEqual(deploys, []);
});

test("deployment_status from another installation records nothing", async () => {
  const { handler, deploys } = webhook();
  await handler(deploymentStatus("success", { installation: { id: 10 } }));
  assert.deepEqual(deploys, []);
});

const PUSHED = new Date("2026-11-18T09:00:00Z");

function versionStep(
  options: { links?: RepoLinkRow[]; flagOff?: boolean; versions?: string[]; pushedAt?: Date } = {},
) {
  const reads: { projectId: string; candidates: readonly string[]; since: Date }[] = [];
  const deploys: string[] = [];
  const now = new Date("2026-11-18T12:00:00Z");
  const pending = [
    { sha: SHA.toUpperCase(), pushedAt: options.pushedAt ?? PUSHED } as RepoCommitRow,
  ];
  const deps: DetectByVersionDeps = {
    listLinksAwaitingDeploy: async () => options.links ?? [LINK],
    flagEnabledForProject: async () => !options.flagOff,
    listPendingCommits: async () => pending,
    readMatchingServiceVersions: async (projectId, candidates, since) => {
      reads.push({ projectId, candidates, since });
      return options.versions ?? [];
    },
    recordDeploy: async (_link, sha) => {
      deploys.push(sha);
      return { shipped: 1, commits: 1 };
    },
    now: () => now,
  };
  return { deps, reads, deploys, now };
}

test("the version step does no span read when no link waits for a deploy", async () => {
  const { deps, reads } = versionStep({ links: [] });
  assert.deepEqual(await detectDeploysByVersion(deps), { links: 0, shipped: 0 });
  assert.deepEqual(reads, []);
});

test("the version step asks the spans only about the pending shas, since the oldest pending commit", async () => {
  const { deps, reads, deploys } = versionStep({ versions: [SHA.slice(0, 7)] });
  assert.deepEqual(await detectDeploysByVersion(deps), { links: 1, shipped: 1 });
  assert.equal(reads.length, 1);
  assert.equal(reads[0].projectId, PROJECT);
  assert.deepEqual(reads[0].since, PUSHED);
  assert.equal(
    reads[0].candidates.length,
    40 - 7 + 1,
    "the full sha and each prefix of 7+ characters",
  );
  assert.ok(
    reads[0].candidates.includes(SHA) &&
      reads[0].candidates.includes(SHA.slice(0, 7)) &&
      !reads[0].candidates.includes(SHA.slice(0, 6)),
  );
  assert.deepEqual(deploys, [SHA.slice(0, 7)]);
});

test("the version step reads at most VERSION_LOOKBACK_MAX_MS back, however old the pending commit", async () => {
  const { deps, reads, now } = versionStep({ pushedAt: new Date("2026-01-01T00:00:00Z") });
  await detectDeploysByVersion(deps);
  assert.deepEqual(reads[0].since, new Date(now.getTime() - VERSION_LOOKBACK_MAX_MS));
});

test("the version step: flag off reads no span and records nothing", async () => {
  const { deps, reads, deploys } = versionStep({ flagOff: true, versions: [SHA] });
  assert.deepEqual(await detectDeploysByVersion(deps), { links: 0, shipped: 0 });
  assert.deepEqual(reads, []);
  assert.deepEqual(deploys, []);
});

test("shaCandidates lowercases and keeps each prefix once", () => {
  assert.deepEqual(shaCandidates([{ sha: "ABCDEF12" }, { sha: "abcdef13" }]), [
    "abcdef1",
    "abcdef12",
    "abcdef13",
  ]);
});
