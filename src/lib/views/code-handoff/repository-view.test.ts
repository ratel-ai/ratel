import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoLinkRow } from "@/lib/views/code-handoff/schema";
import { createFakeGitHub } from "./fake-github";
import type { LinkServiceDeps } from "./link-service";
import { loadRepositoryView } from "./repository-view";
import { signInstallGrant } from "./setup-state";

const SECRET = "test-webhook-secret";
const NOW = Date.parse("2026-11-17T10:00:00Z");
const ACTOR = { projectId: "11111111-1111-4111-8111-111111111111", externalId: "user_a" };

function deps(overrides: Partial<LinkServiceDeps> = {}): LinkServiceDeps {
  const github = createFakeGitHub();
  github.addRepo(7, { id: 501, owner: "acme", name: "agent", defaultBranch: "main" });
  return {
    secret: SECRET,
    github,
    projectAccess: async () => ({ organizationId: "org" }),
    flagEnabled: async () => true,
    isRestricted: async () => false,
    getRepoLink: async () => null,
    linkRepo: async () => {
      throw new Error("no write expected");
    },
    unlinkRepo: async () => false,
    log: () => {},
    track: async () => {},
    now: () => NOW,
    ...overrides,
  };
}

test("without the App's settings the tab says not configured", async () => {
  assert.deepEqual(
    await loadRepositoryView(
      { actor: ACTOR, appSlug: null, grant: null, setupError: null },
      deps({ secret: null }),
    ),
    { state: "not_configured" },
  );
  assert.deepEqual(
    await loadRepositoryView(
      { actor: ACTOR, appSlug: "ratel", grant: null, setupError: null },
      deps({ secret: null }),
    ),
    { state: "not_configured" },
  );
});

test("not connected: an Install link with a state, and the setup error in words", async () => {
  const view = await loadRepositoryView(
    { actor: ACTOR, appSlug: "ratel-dev", grant: null, setupError: "invalid_state" },
    deps(),
  );
  assert.equal(view.state, "not_connected");
  if (view.state !== "not_connected") return;
  assert.equal(view.installUrl, `/api/github/install?project=${ACTOR.projectId}`);
  assert.equal(view.authorizeUrl, `/api/github/install?project=${ACTOR.projectId}&mode=authorize`);
  assert.match(view.error ?? "", /expired/);
});

test("with a grant: the installation's repos to pick from", async () => {
  const grant = signInstallGrant({ ...ACTOR, installationIds: [7] }, SECRET, NOW);
  const view = await loadRepositoryView(
    { actor: ACTOR, appSlug: "ratel-dev", grant, setupError: null },
    deps(),
  );
  assert.equal(view.state, "picking");
  if (view.state === "picking")
    assert.deepEqual(
      view.repos.map((repo) => repo.fullName),
      ["acme/agent"],
    );
});

test("linked: the repo, and the setup hint names the App's bot", async () => {
  const link = { owner: "acme", name: "agent", defaultBranch: "main" } as RepoLinkRow;
  const view = await loadRepositoryView(
    { actor: ACTOR, appSlug: "ratel-dev", grant: null, setupError: null },
    deps({ getRepoLink: async () => link }),
  );
  assert.deepEqual(view, {
    state: "linked",
    link: { owner: "acme", name: "agent", defaultBranch: "main" },
    url: "https://github.com/acme/agent",
    hint: { botLogin: "ratel-dev[bot]" },
  });
});
