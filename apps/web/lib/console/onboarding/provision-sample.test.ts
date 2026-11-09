import assert from "node:assert/strict";
import { test } from "node:test";
import { type EnsureSampleProjectDeps, ensureSampleProject } from "./provision-sample";

const ORG = { id: "22222222-2222-4222-8222-222222222222", name: "Acme", slug: "acme" };
const PROJECT = "11111111-1111-4111-8111-111111111111";
const context = { organization: ORG, externalId: "user-1" };

function deps(over: Partial<EnsureSampleProjectDeps> = {}) {
  const calls = {
    claimed: 0,
    seeded: 0,
    recorded: [] as string[],
    drained: [] as string[],
    tracked: [] as string[],
    reported: 0,
  };
  const value: EnsureSampleProjectDeps = {
    listProjects: async () => [],
    claim: async () => {
      calls.claimed += 1;
      return true;
    },
    seed: async () => {
      calls.seeded += 1;
      return {
        projectId: PROJECT,
        projectSlug: "site-copilot",
        skills: 3,
        traces: 40,
      };
    },
    record: async (_org, projectId) => {
      calls.recorded.push(projectId);
    },
    scheduleDrain: (projectId) => {
      calls.drained.push(projectId);
    },
    track: async (event) => {
      calls.tracked.push(event);
    },
    reportException: () => {
      calls.reported += 1;
    },
    now: () => 1_000,
    ...over,
  };
  return { value, calls };
}

test("an empty, never-seeded organization gets the sample once, recorded, drained and tracked", async () => {
  const { value, calls } = deps();
  assert.equal(await ensureSampleProject(context, value), PROJECT);
  assert.deepEqual(calls, {
    claimed: 1,
    seeded: 1,
    recorded: [PROJECT],
    drained: [PROJECT],
    tracked: ["demo_project_seeded"],
    reported: 0,
  });
});

test("an organization with projects is left alone before the mark is even read", async () => {
  const { value, calls } = deps({
    listProjects: async () => [{ id: "p-1" }],
    claim: async () => assert.fail("the mark must not be claimed"),
  });
  assert.equal(await ensureSampleProject(context, value), null);
  assert.equal(calls.seeded, 0);
});

test("a lost claim seeds nothing: a deleted sample does not come back", async () => {
  const { value, calls } = deps({ claim: async () => false });
  assert.equal(await ensureSampleProject(context, value), null);
  assert.equal(calls.seeded, 0);
  assert.deepEqual(calls.tracked, []);
});

test("a failing seed is reported and swallowed, and the claim stays", async () => {
  const { value, calls } = deps({
    seed: async () => {
      throw new Error("ingest returned 500");
    },
  });
  assert.equal(await ensureSampleProject(context, value), null);
  assert.equal(calls.claimed, 1);
  assert.equal(calls.reported, 1);
  assert.deepEqual(calls.tracked, ["demo_project_seed_failed"]);
  assert.deepEqual(calls.drained, []);
});
