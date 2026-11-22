import assert from "node:assert/strict";
import { test } from "node:test";
import { McpOperationError } from "@/lib/mcp/errors";
import { codeHandoffOperations } from "@/lib/mcp/operations/code-handoff";
import type { HandoffFixDeps } from "@/lib/views/code-handoff/handoff/handoff-fix";
import type { FixHandoffRow, RepoLinkRow } from "@/lib/views/code-handoff/schema";

const LINK = { id: "link-1", installationId: 7, owner: "acme", name: "agent" } as RepoLinkRow;
const ctx = { projectId: "p1", auth: { kind: "api-key" }, organizationId: "org-1" } as never;
const params = { projectId: "p1", fixId: "craft:c-merge" } as never;

function fakeDeps(over: Partial<HandoffFixDeps> = {}) {
  const rows: FixHandoffRow[] = [];
  const issues: string[] = [];
  const events: Record<string, unknown>[] = [];
  const deps: HandoffFixDeps = {
    flagEnabled: async () => true,
    getRepoLink: async () => LINK,
    getRepo: async () => ({
      id: 1,
      owner: "acme",
      name: "agent",
      fullName: "acme/agent",
      defaultBranch: "main",
      private: true,
    }),
    getHandoff: async (_p, fixId) => rows.find((row) => row.fixId === fixId) ?? null,
    loadBrief: async (_p, fixId) =>
      fixId === "craft:c-merge"
        ? {
            fix: { id: fixId, title: "Merge", kind: "merge" } as never,
            brief: `brief\n\nratel-fix: ${fixId}`,
          }
        : null,
    target: {
      id: "github-issue-claude",
      async handoff() {
        issues.push("issue");
        return {
          externalId: String(issues.length),
          url: `https://github.com/acme/agent/issues/${issues.length}`,
        };
      },
    },
    recordHandoff: async (handoff) => {
      const row = { id: "h", createdAt: new Date(), ...handoff };
      rows.push(row);
      return row;
    },
    track: async (_event, _context, properties) => {
      events.push(properties);
    },
    requestIndex: async () => undefined,
    ...over,
  };
  return { deps, issues, events };
}

function tool(deps: HandoffFixDeps | null) {
  const operation = codeHandoffOperations({ handoffDeps: async () => deps }).find(
    (candidate) => candidate.id === "handoff_fix",
  );
  assert.ok(operation);
  return operation;
}

test("handoff_fix opens one issue, then returns it again without opening another", async () => {
  const fake = fakeDeps();
  const first = (await tool(fake.deps).execute(ctx, params)) as {
    data: { handoff: { url: string; created: boolean } };
  };
  const second = (await tool(fake.deps).execute(ctx, params)) as {
    data: { handoff: { url: string; created: boolean } };
  };
  assert.equal(first.data.handoff.created, true);
  assert.equal(second.data.handoff.url, first.data.handoff.url);
  assert.equal(second.data.handoff.created, false);
  assert.equal(fake.issues.length, 1);
  assert.equal(fake.events.length, 1);
  assert.equal(fake.events[0]!.surface, "mcp");
});

test("with the flag off handoff_fix answers forbidden", async () => {
  const fake = fakeDeps({ flagEnabled: async () => false });
  await assert.rejects(
    tool(fake.deps).execute(ctx, params),
    (error: unknown) => error instanceof McpOperationError && error.code === "forbidden",
  );
  assert.equal(fake.issues.length, 0);
});

test("without a linked repo handoff_fix answers invalid_params", async () => {
  const fake = fakeDeps({ getRepoLink: async () => null });
  await assert.rejects(
    tool(fake.deps).execute(ctx, params),
    (error: unknown) =>
      error instanceof McpOperationError &&
      error.code === "invalid_params" &&
      /Repository/.test(error.message),
  );
});

test("on a public repo handoff_fix answers invalid_params and opens no issue", async () => {
  const fake = fakeDeps({
    getRepo: async () => ({
      id: 1,
      owner: "acme",
      name: "agent",
      fullName: "acme/agent",
      defaultBranch: "main",
      private: false,
    }),
  });
  await assert.rejects(
    tool(fake.deps).execute(ctx, params),
    (error: unknown) =>
      error instanceof McpOperationError &&
      error.code === "invalid_params" &&
      /This repo is public/.test(error.message),
  );
  assert.equal(fake.issues.length, 0);
});

test("an unknown fix or project is not found", async () => {
  await assert.rejects(
    tool(fakeDeps().deps).execute(ctx, { projectId: "p1", fixId: "craft:nope" } as never),
    (error: unknown) => error instanceof McpOperationError && error.code === "not_found",
  );
  await assert.rejects(
    tool(null).execute(ctx, params),
    (error: unknown) => error instanceof McpOperationError && error.code === "not_found",
  );
});

test("handoff_fix says it changes something", () => {
  const operation = tool(fakeDeps().deps);
  assert.equal(operation.mutates, true);
  assert.match(operation.description, /changes something/);
});
