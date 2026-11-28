import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalCase } from "../domain/case";
import { newAddress, type OldAddressDeps } from "../old-addresses";
import { run } from "./runs";
import { PROJECT_ID } from "./support";

const RUN = "22222222-2222-4222-8222-222222222222";
const TRIAL = "33333333-3333-4333-8333-333333333333";
const CASE = "44444444-4444-4444-8444-444444444444";
const EVAL = "55555555-5555-4555-8555-555555555555";

function deps(over: Partial<OldAddressDeps> = {}): OldAddressDeps {
  const made = run(RUN, { [EVAL]: { cases: { a: ["pass"] } } });
  return {
    isMember: async () => true,
    experiment: async (projectId, id) =>
      projectId === PROJECT_ID && id === RUN ? made.experiment : null,
    evalCase: async (projectId, id) =>
      projectId === PROJECT_ID && id === CASE ? ({ datasetId: "d1" } as EvalCase) : null,
    ...over,
  };
}

test("an old run, trial and comparison lead into the eval of the run", async () => {
  const base = `/project/${PROJECT_ID}`;
  assert.equal(
    await newAddress(PROJECT_ID, { kind: "run", experimentId: RUN }, deps()),
    `${base}/evals/${EVAL}/runs/${RUN}`,
  );
  assert.equal(
    await newAddress(PROJECT_ID, { kind: "run", experimentId: RUN, trialId: TRIAL }, deps()),
    `${base}/evals/${EVAL}/runs/${RUN}/trials/${TRIAL}`,
  );
  assert.equal(await newAddress(PROJECT_ID, { kind: "new_eval" }, deps()), `${base}/evals?new=1`);
  assert.equal(
    await newAddress(PROJECT_ID, { kind: "case", caseId: CASE }, deps()),
    `${base}/datasets/d1`,
  );
  assert.equal(
    await newAddress(PROJECT_ID, { kind: "case", caseId: "new" }, deps()),
    `${base}/datasets`,
  );
});

test("a run with no eval leads to the Evals page; another project, a stranger or a bad id get nothing", async () => {
  const legacy = run(RUN, {});
  assert.equal(
    await newAddress(
      PROJECT_ID,
      { kind: "run", experimentId: RUN },
      deps({ experiment: async () => legacy.experiment }),
    ),
    `/project/${PROJECT_ID}/evals`,
  );
  const other = "99999999-9999-4999-8999-999999999999";
  assert.equal(await newAddress(other, { kind: "run", experimentId: RUN }, deps()), null);
  assert.equal(
    await newAddress(
      PROJECT_ID,
      { kind: "case", caseId: CASE },
      deps({ isMember: async () => false }),
    ),
    null,
  );
  assert.equal(await newAddress(PROJECT_ID, { kind: "run", experimentId: "nope" }, deps()), null);
  assert.equal(
    await newAddress(PROJECT_ID, { kind: "run", experimentId: RUN, trialId: "x" }, deps()),
    null,
  );
});
