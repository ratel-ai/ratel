import assert from "node:assert/strict";
import { test } from "node:test";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import type { Dataset } from "../domain/dataset";
import { encodeRowCursor } from "../domain/overrides";
import {
  handleDatasetRowsRequest,
  handleOverridesRequest,
  type ReviewApiDeps,
} from "../review-api";

/** RC-1130: the guards of the rows and overrides routes. The database paths are in `build.integration.test.ts`. */

const DATASET_ID = "77777777-7777-4777-8777-777777777777";
const USE_CASE_ID = "55555555-5555-4555-8555-555555555555";
const TURN_ID = "88888888-8888-4888-8888-888888888888";
const DATASET = { id: DATASET_ID, projectId: "p1", useCaseId: USE_CASE_ID } as Dataset;

function harness(options: { signedIn?: boolean; flag?: boolean; restricted?: boolean } = {}) {
  const writes: unknown[] = [];
  const deps: ReviewApiDeps = {
    getSession: async () =>
      options.signedIn === false ? null : { user: { id: "u1", externalId: "user_1" } },
    findProjectScope: async () => ({
      project: { id: "p1" } as Project,
      organization: { id: "org-1" } as Organization,
      role: "member",
    }),
    fineTuningEnabled: async () => options.flag !== false,
    isRestricted: async () => options.restricted === true,
    // Every fake answers for project p1 only, as the real stores do.
    datasets: () => ({
      getDataset: async (projectId, id) =>
        projectId === DATASET.projectId && id === DATASET_ID ? DATASET : null,
      listRows: async (projectId) => {
        assert.equal(projectId, DATASET.projectId, "rows are read in the dataset's project");
        return [];
      },
    }),
    overrides: () => ({
      listOverrides: async (projectId) => {
        assert.equal(projectId, DATASET.projectId, "overrides are read in the dataset's project");
        return [];
      },
      setOverride: async (projectId, useCaseId, input) => {
        if (projectId !== DATASET.projectId || useCaseId !== USE_CASE_ID)
          return { ok: false, reason: "use_case_not_found" };
        writes.push(input);
        return {
          ok: true,
          override: {
            turnId: input.turnId,
            pinned: false,
            excluded: true,
            setBy: "user_1",
            updatedAt: new Date(0),
          },
        };
      },
    }),
    track: async () => {},
  };
  return { deps, writes };
}

const rows = (query = "") => new Request(`http://test/rows${query}`);
const put = (body: unknown) =>
  new Request("http://test/overrides", { method: "PUT", body: JSON.stringify(body) });

test("signed out is 401; flag off is not found, for both routes", async () => {
  assert.equal(
    (await handleDatasetRowsRequest(rows(), "p1", DATASET_ID, harness({ signedIn: false }).deps))
      .status,
    401,
  );
  assert.equal(
    (await handleDatasetRowsRequest(rows(), "p1", DATASET_ID, harness({ flag: false }).deps))
      .status,
    404,
  );
  const off = harness({ flag: false });
  assert.equal(
    (
      await handleOverridesRequest(
        put({ turnId: TURN_ID, excluded: true }),
        "p1",
        USE_CASE_ID,
        off.deps,
      )
    ).status,
    404,
  );
  assert.deepEqual(off.writes, []);
});

test("the rows route refuses a bad side, limit or a cursor of another listing; an unknown dataset is 404", async () => {
  const { deps } = harness();
  assert.equal(
    (await handleDatasetRowsRequest(rows("?side=all"), "p1", DATASET_ID, deps)).status,
    400,
  );
  assert.equal(
    (await handleDatasetRowsRequest(rows("?limit=0"), "p1", DATASET_ID, deps)).status,
    400,
  );
  assert.equal(
    (await handleDatasetRowsRequest(rows("?limit=101"), "p1", DATASET_ID, deps)).status,
    400,
  );
  const trainCursor = encodeRowCursor(DATASET_ID, "train", 3);
  assert.equal(
    (
      await handleDatasetRowsRequest(
        rows(`?side=eval&cursor=${trainCursor}`),
        "p1",
        DATASET_ID,
        deps,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handleDatasetRowsRequest(
        rows(`?side=train&cursor=${trainCursor}`),
        "p1",
        DATASET_ID,
        deps,
      )
    ).status,
    200,
  );
  assert.equal(
    (await handleDatasetRowsRequest(rows(), "p1", "66666666-6666-4666-8666-666666666666", deps))
      .status,
    404,
  );
});

test("a support session cannot set an override; an empty or unknown change is 400", async () => {
  const restricted = harness({ restricted: true });
  assert.equal(
    (
      await handleOverridesRequest(
        put({ turnId: TURN_ID, excluded: true }),
        "p1",
        USE_CASE_ID,
        restricted.deps,
      )
    ).status,
    403,
  );
  assert.deepEqual(restricted.writes, []);
  const { deps, writes } = harness();
  assert.equal(
    (await handleOverridesRequest(put({ turnId: TURN_ID }), "p1", USE_CASE_ID, deps)).status,
    400,
  );
  assert.equal(
    (
      await handleOverridesRequest(
        put({ turnId: TURN_ID, excluded: true, note: "x" }),
        "p1",
        USE_CASE_ID,
        deps,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handleOverridesRequest(
        put({ turnId: TURN_ID, excluded: true }),
        "p1",
        USE_CASE_ID,
        deps,
      )
    ).status,
    200,
  );
  assert.deepEqual(writes, [{ turnId: TURN_ID, excluded: true }]);
});
