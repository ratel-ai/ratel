import assert from "node:assert/strict";
import { test } from "node:test";
import type { Organization } from "@/lib/platform/organizations";
import type { FixHandoffRow, RepoLinkRow } from "@/lib/views/code-handoff/schema";
import { buildFixes } from "@/lib/views/fixes/build";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";
import { createFakeGitHub } from "../fake-github";
import { fixMarker } from "../marker";
import type { NewFixHandoff } from "../store";
import { createGitHubIssueClaudeTarget, issueTitle } from "./github-issue-claude";
import { type HandoffFixDeps, handoffFix } from "./handoff-fix";
import { loadHandoffBrief } from "./load-brief";

const PROJECT = "p1";
const INSTALLATION = 7;
const LINK: RepoLinkRow = {
  id: "link-1",
  projectId: PROJECT,
  installationId: INSTALLATION,
  repoId: 1,
  owner: "acme",
  name: "agent",
  defaultBranch: "main",
  linkedBy: "user_1",
  createdAt: new Date("2026-11-18T00:00:00.000Z"),
};

function harness(
  over: Partial<HandoffFixDeps> = {},
  repo: { private: boolean } = { private: true },
) {
  const github = createFakeGitHub();
  github.addRepo(
    INSTALLATION,
    { id: 1, owner: "acme", name: "agent", defaultBranch: "main", ...repo },
    {},
  );
  const rows: FixHandoffRow[] = [];
  const events: { event: string; properties: Record<string, unknown> }[] = [];
  const indexRequests: string[] = [];
  const model = buildFixes(fixesInput());
  const deps: HandoffFixDeps = {
    getRepoLink: async () => LINK,
    getRepo: (installationId, ref) => github.getRepo(installationId, ref),
    getHandoff: async (projectId, fixId, target) =>
      rows.find(
        (row) => row.projectId === projectId && row.fixId === fixId && row.target === target,
      ) ?? null,
    loadBrief: (projectId, fixId) =>
      loadHandoffBrief(
        { projectId, organization: { id: "org-1" } as Organization, fixId },
        {
          loadFixes: async () => model,
          codePointers: async () => [
            { kind: "tool", symbol: "find_task", path: "src/tools/tasks.ts", line: 12 },
          ],
          exampleTraceIds: async () => ["4bf92f3577b34da6a3ce929d0e0e4736"],
          evalSet: async () => null,
          consoleBaseUrl: () => "https://cloud.ratel.sh",
        },
      ),
    target: createGitHubIssueClaudeTarget(github),
    recordHandoff: async (handoff: NewFixHandoff) => {
      const existing = rows.find(
        (row) =>
          row.projectId === handoff.projectId &&
          row.fixId === handoff.fixId &&
          row.target === handoff.target,
      );
      if (existing) return existing;
      const row: FixHandoffRow = { id: `h-${rows.length + 1}`, createdAt: new Date(), ...handoff };
      rows.push(row);
      return row;
    },
    track: async (event, _context, properties) => {
      events.push({ event, properties });
    },
    requestIndex: async (projectId) => {
      indexRequests.push(projectId);
    },
    ...over,
  };
  return { deps, github, rows, events, indexRequests };
}

const input = (fixId: string, surface: "fixes" | "mcp" = "fixes") => ({
  projectId: PROJECT,
  fixId,
  handedOffBy: "user_1",
  context: { externalId: "user_1", projectId: PROJECT },
  surface,
});

test("a handoff opens one issue that mentions @claude and carries the marker", async () => {
  const h = harness();
  const result = await handoffFix(input("craft:c-merge"), h.deps);
  assert.ok(result.ok);
  assert.equal(result.created, true);
  assert.equal(h.github.issues.length, 1);
  const [issue] = h.github.issues;
  assert.ok(issue.body.startsWith("@claude"), "the body starts with the mention");
  assert.ok(issue.body.includes(fixMarker("craft:c-merge")));
  assert.ok(
    issue.body.includes("## Problem") &&
      issue.body.includes("## Suggestion") &&
      issue.body.includes("## Expected effect"),
  );
  assert.ok(issue.body.includes("src/tools/tasks.ts:12 find_task"));
  assert.ok(issue.title.startsWith("Ratel fix: "));
  assert.equal(result.url, issue.url);
  assert.deepEqual(
    h.rows.map((row) => [row.fixId, row.target, row.url]),
    [["craft:c-merge", "github-issue-claude", issue.url]],
  );
  assert.deepEqual(h.indexRequests, [PROJECT], "a stale index is refreshed in the background");
});

test("a second handoff of the same fix returns the first issue and opens nothing", async () => {
  const h = harness();
  const first = await handoffFix(input("craft:c-merge"), h.deps);
  const second = await handoffFix(input("craft:c-merge", "mcp"), h.deps);
  assert.ok(first.ok && second.ok);
  assert.equal(second.url, first.url);
  assert.equal(second.created, false);
  assert.equal(h.github.issues.length, 1);
});

test("fix_handed_off is emitted once per new handoff, with its target and surface", async () => {
  const h = harness();
  await handoffFix(input("craft:c-merge", "mcp"), h.deps);
  await handoffFix(input("craft:c-merge", "mcp"), h.deps);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.event, "fix_handed_off");
  assert.equal(h.events[0]!.properties.target, "github-issue-claude");
  assert.equal(h.events[0]!.properties.surface, "mcp");
  assert.equal(h.events[0]!.properties.fix_id, "craft:c-merge");
});

test("without a linked repo the handoff refuses with no_repo_linked", async () => {
  const h = harness({ getRepoLink: async () => null });
  assert.deepEqual(await handoffFix(input("craft:c-merge"), h.deps), {
    ok: false,
    error: "no_repo_linked",
  });
  assert.equal(h.github.issues.length, 0);
});

test("a public repo is refused with public_repo and no issue is opened", async () => {
  const h = harness({}, { private: false });
  assert.deepEqual(await handoffFix(input("craft:c-merge"), h.deps), {
    ok: false,
    error: "public_repo",
  });
  assert.equal(h.github.issues.length, 0);
  assert.equal(h.rows.length, 0);
  assert.equal(h.events.length, 0);
});

test("a repo the installation can no longer read is refused with public_repo", async () => {
  const h = harness();
  h.github.removeInstallation(INSTALLATION);
  assert.deepEqual(await handoffFix(input("craft:c-merge"), h.deps), {
    ok: false,
    error: "public_repo",
  });
  assert.equal(h.github.issues.length, 0);
});

test("an unknown fix is not found", async () => {
  const h = harness();
  assert.deepEqual(await handoffFix(input("craft:nope"), h.deps), {
    ok: false,
    error: "fix_not_found",
  });
});

test("a failing index request never fails the handoff", async () => {
  const h = harness({
    requestIndex: async () => {
      throw new Error("queue down");
    },
  });
  assert.ok((await handoffFix(input("craft:c-merge"), h.deps)).ok);
});

test("the issue title is one line, capped, with no mention or backtick", () => {
  assert.equal(issueTitle("Merge `a` and\n@b"), "Ratel fix: Merge ˋaˋ and ＠b");
  assert.ok(issueTitle("x".repeat(500)).length <= 140);
});
