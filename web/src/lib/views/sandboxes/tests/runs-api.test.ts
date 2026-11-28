import assert from "node:assert/strict";
import { test } from "node:test";
import { EVAL_TRIAL_PREFIX, type SandboxRun } from "../domain/run";
import type { RunDeps } from "../runs";
import { handleGetRun, type RunsApiDeps } from "../runs-api";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const EVAL_RUN = "22222222-2222-4222-8222-222222222222";
const PLAYGROUND_RUN = "33333333-3333-4333-8333-333333333333";

function run(id: string, requestedBy: string): SandboxRun {
  return {
    id,
    projectId: PROJECT,
    versionId: "v1",
    status: "failed",
    reason: "agent_error: could not answer captured ask",
    errorCode: "agent_error",
    request: { v: 1, runId: id, input: { message: "captured ask" }, params: { tone: "captured" } },
    result: { output: "captured answer" },
    logs: "agent log",
    traceId: null,
    requestedBy,
    createdAt: new Date(0),
    startedAt: null,
    finishedAt: null,
  } as unknown as SandboxRun;
}

function deps(optIn: boolean): RunsApiDeps {
  const runs = new Map([
    [EVAL_RUN, run(EVAL_RUN, `${EVAL_TRIAL_PREFIX}t-1`)],
    [PLAYGROUND_RUN, run(PLAYGROUND_RUN, "user_1")],
  ]);
  return {
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) => ({
      project: { id: projectId },
      organization: { id: "org-1" },
      role: "member",
    }),
    enabled: async () => true,
    isRestricted: async () => false,
    runDeps: () =>
      ({
        runs: { get: async (projectId: string, id: string) => runs.get(id) ?? null },
      }) as unknown as RunDeps,
    track: async () => {},
    contentOptIn: async () => optIn,
  };
}

test("a member reads a run that an eval started without its text when the project does not let Ratel read it", async () => {
  const closed = await (await handleGetRun(PROJECT, EVAL_RUN, deps(false))).json();
  assert.equal(closed.contentWithheld, true);
  assert.equal(closed.input, null);
  assert.equal(closed.result, null);
  assert.equal(closed.logs, null);
  // The agent writes the reason, and can repeat its input there. The params are of the eval.
  assert.equal(closed.reason, null);
  assert.equal(closed.params, null);
  assert.equal(closed.status, "failed");
  assert.equal(closed.errorCode, "agent_error");
  const open = await (await handleGetRun(PROJECT, EVAL_RUN, deps(true))).json();
  assert.deepEqual(open.input, { message: "captured ask" });
  assert.equal(open.logs, "agent log");
  assert.equal(open.reason, "agent_error: could not answer captured ask");
  assert.deepEqual(open.params, { tone: "captured" });
  assert.equal(open.contentWithheld, undefined);
  // A Playground run is typed by the member: it shows.
  const own = await (await handleGetRun(PROJECT, PLAYGROUND_RUN, deps(false))).json();
  assert.deepEqual(own.input, { message: "captured ask" });
});
