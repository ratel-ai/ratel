import assert from "node:assert/strict";
import { test } from "node:test";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import type { DatasetBuildDeps } from "../build";
import { type DatasetsApiDeps, handleDatasetsRequest } from "../datasets-api";
import type { Dataset, DatasetSettings } from "../domain/dataset";
import type { UseCase } from "../domain/use-case";

/** RC-1128: the datasets route lists versions and starts a build; with no opt-in it refuses. */

const PROJECT = { id: "p1", organizationId: "org-1" } as Project;
const ORGANIZATION = { id: "org-1", slug: "acme" } as Organization;
const USE_CASE_ID = "55555555-5555-4555-8555-555555555555";
const USE_CASE: UseCase = {
  id: USE_CASE_ID,
  projectId: "p1",
  name: "Triage",
  selector: { taskIds: ["triage"], intentIds: [] },
  createdBy: "user_1",
  createdAt: new Date("2026-11-20T00:00:00Z"),
  archivedAt: null,
};

function harness(options: { consent?: boolean; flag?: boolean; restricted?: boolean } = {}) {
  const created: Dataset[] = [];
  const queued: string[] = [];
  const build = {
    useCases: {
      getUseCase: async (_p: string, id: string) => (id === USE_CASE_ID ? USE_CASE : null),
    },
    consents: {
      getActiveConsent: async () => (options.consent === false ? null : ({ id: "c1" } as never)),
    },
    flagOn: async () => true,
    datasets: {
      listDatasets: async () => created,
      createBuilding: async (
        projectId: string,
        input: { useCaseId: string; settings: DatasetSettings; createdBy: string },
      ) => {
        const dataset: Dataset = {
          id: "d1",
          projectId,
          useCaseId: input.useCaseId,
          version: 1,
          status: "building",
          settings: input.settings,
          contentHash: null,
          counts: null,
          redactionReport: null,
          createdBy: input.createdBy,
          createdAt: new Date("2026-11-20T00:00:00Z"),
          failedReason: null,
        };
        created.push(dataset);
        return dataset;
      },
    },
    enqueue: async (_projectId: string, payload: { datasetId: string }) => {
      queued.push(payload.datasetId);
    },
    track: async () => {},
    now: () => new Date("2026-11-20T00:00:00Z"),
  } as unknown as DatasetBuildDeps;
  const deps: DatasetsApiDeps = {
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async () => ({
      project: PROJECT,
      organization: ORGANIZATION,
      role: "member",
    }),
    fineTuningEnabled: async () => options.flag !== false,
    isRestricted: async () => options.restricted === true,
    build: () => build,
  };
  return { deps, created, queued };
}

const post = (body: unknown) =>
  new Request("http://test/datasets", { method: "POST", body: JSON.stringify(body) });
const get = () => new Request("http://test/datasets");

test("POST starts a build: 202, a building version, its job queued; GET lists it with no row text", async () => {
  const { deps, queued } = harness();
  const response = await handleDatasetsRequest(
    post({ seed: 4, evalFraction: 0.2 }),
    "p1",
    USE_CASE_ID,
    deps,
  );
  assert.equal(response.status, 202);
  const body = (await response.json()) as {
    dataset: { status: string; settings: { seed: number; evalFraction: number; dedup: string } };
  };
  assert.deepEqual(
    [
      body.dataset.status,
      body.dataset.settings.seed,
      body.dataset.settings.evalFraction,
      body.dataset.settings.dedup,
    ],
    ["building", 4, 0.2, "near"],
  );
  assert.deepEqual(queued, ["d1"]);

  const listed = (await (await handleDatasetsRequest(get(), "p1", USE_CASE_ID, deps)).json()) as {
    datasets: Record<string, unknown>[];
  };
  assert.equal(listed.datasets.length, 1);
  assert.equal("rows" in listed.datasets[0]!, false);
});

test("with no opt-in, POST is refused with no_consent and a message that names the opt-in", async () => {
  const { deps, created } = harness({ consent: false });
  const response = await handleDatasetsRequest(post({}), "p1", USE_CASE_ID, deps);
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string; message: string };
  assert.equal(body.error, "no_consent");
  assert.match(body.message, /opt-in/);
  assert.deepEqual(created, []);
});

test("flag off is not found; bad settings are 400; an unknown use case is 404; a support session cannot build", async () => {
  assert.equal(
    (await handleDatasetsRequest(post({}), "p1", USE_CASE_ID, harness({ flag: false }).deps))
      .status,
    404,
  );
  const bad = await handleDatasetsRequest(
    post({ evalFraction: 0.9 }),
    "p1",
    USE_CASE_ID,
    harness().deps,
  );
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, "invalid");
  assert.equal(
    (
      await handleDatasetsRequest(
        post({}),
        "p1",
        "66666666-6666-4666-8666-666666666666",
        harness().deps,
      )
    ).status,
    404,
  );
  assert.equal(
    (await handleDatasetsRequest(post({}), "p1", USE_CASE_ID, harness({ restricted: true }).deps))
      .status,
    403,
  );
});
