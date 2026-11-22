import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchResult, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  createDrizzleDatasetStore,
  createDrizzleOverrideStore,
} from "@/lib/views/fine-tuning/adapters/drizzle-dataset-store";
import {
  createDrizzleModelCallSource,
  createDrizzleUseCaseStore,
} from "@/lib/views/fine-tuning/adapters/drizzle-store";
import { recordDatasetSource } from "@/lib/views/fine-tuning/build-deps";
import { datasetSettings } from "@/lib/views/fine-tuning/domain/dataset";
import { emptyCounts } from "@/lib/views/fine-tuning/domain/redaction";
import { emptyDrops } from "@/lib/views/fine-tuning/domain/rows";
import { loadUseCaseStats } from "@/lib/views/fine-tuning/resolve";
import { type FineTuningOperationDeps, fineTuningOperations } from "./fine-tuning";

/**
 * RC-1156: the dataset tools never reach a dataset of another project. A
 * dataset of project A, on embedded Postgres, with its rows and its lineage
 * link. Callers in project B (an API key with content:read, an OAuth member
 * of B's organization only) call get_dataset, list_dataset_rows and
 * delete_dataset with A's dataset id. Each call gets the same refusal as an
 * unknown id, the response holds nothing of the dataset, and A's dataset,
 * rows and lineage link stay. The stores are the real drizzle stores: every
 * read takes the project the dispatcher resolved.
 */

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "33333333-3333-4333-8333-333333333333";
const UNKNOWN_ID = "66666666-6666-4666-8666-666666666666";
const SECRET_TEXT = "project A private ask";

const API_KEY_B: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT_B,
  apiKeyId: "key-b",
  scopes: ["mcp:read", "mcp:write", "content:read"],
  organization: { id: ORG_B, slug: "org-b", effectivePlan: "pro" },
};

const OAUTH_B: McpAuthContext = {
  kind: "oauth",
  externalUserId: "user_b",
  userId: "u-b",
  memberships: [
    {
      organizationId: ORG_B,
      role: "admin",
      organization: { id: ORG_B, slug: "org-b", effectivePlan: "pro" },
    },
  ],
};

const TOOLS = ["get_dataset", "list_dataset_rows", "delete_dataset"] as const;

test("from project B, get_dataset, list_dataset_rows and delete_dataset refuse A's dataset exactly as an unknown id, and A's dataset stays", async () => {
  const h = await seeded();
  try {
    for (const [caller, auth, projectId] of [
      ["API key of B", API_KEY_B, undefined],
      ["OAuth member of B", OAUTH_B, PROJECT_B],
    ] as const) {
      for (const tool of TOOLS) {
        const foreign = await h.run(auth, tool, {
          ...(projectId ? { projectId } : {}),
          datasetId: h.datasetId,
        });
        const unknown = await h.run(auth, tool, {
          ...(projectId ? { projectId } : {}),
          datasetId: UNKNOWN_ID,
        });
        assert.equal(foreign.ok, false, `${caller} ${tool}`);
        assert.equal(unknown.ok, false, `${caller} ${tool} (unknown id)`);
        assert.equal(foreign.ok === false && foreign.error, "not_found", `${caller} ${tool}`);
        assert.deepEqual(
          foreign,
          unknown,
          `${caller} ${tool}: the refusal does not tell A's dataset from an unknown id`,
        );
        assertLeaksNothing(foreign, `${caller} ${tool}`);
      }
    }
    await assertDatasetIntact(h);
  } finally {
    await h.client.close();
  }
});

test("an OAuth member of B who names project A is refused as not found before any tool reads, and A's dataset stays", async () => {
  const h = await seeded();
  try {
    for (const tool of TOOLS) {
      const named = await h.run(OAUTH_B, tool, { projectId: PROJECT_A, datasetId: h.datasetId });
      const nowhere = await h.run(OAUTH_B, tool, { projectId: UNKNOWN_ID, datasetId: h.datasetId });
      assert.equal(named.ok === false && named.error, "not_found", tool);
      assert.deepEqual(named, nowhere, `${tool}: project A reads as a project that does not exist`);
      assertLeaksNothing(named, tool);
    }
    // An API key of B that names A is refused by its scope.
    const keyed = await h.run(API_KEY_B, "delete_dataset", {
      projectId: PROJECT_A,
      datasetId: h.datasetId,
    });
    assert.equal(keyed.ok === false && keyed.error, "forbidden");
    assertLeaksNothing(keyed, "api key naming A");
    await assertDatasetIntact(h);
  } finally {
    await h.client.close();
  }
});

test("control: the same tools in project A read the dataset and delete it, rows and lineage link included", async () => {
  const h = await seeded();
  try {
    const apiKeyA: McpAuthContext = {
      ...API_KEY_B,
      projectId: PROJECT_A,
      apiKeyId: "key-a",
      organization: { id: ORG_A, slug: "org-a", effectivePlan: "pro" },
    };
    const got = await h.run(apiKeyA, "get_dataset", { datasetId: h.datasetId });
    assert.ok(got.ok, JSON.stringify(got));
    const rows = await h.run(apiKeyA, "list_dataset_rows", { datasetId: h.datasetId });
    assert.ok(
      rows.ok && JSON.stringify(rows.data).includes(SECRET_TEXT),
      "A reads its own row text",
    );
    const deleted = await h.run(apiKeyA, "delete_dataset", { datasetId: h.datasetId });
    assert.ok(deleted.ok, JSON.stringify(deleted));
    assert.deepEqual(await h.counts(), { datasets: 0, rows: 0, links: 0 });
  } finally {
    await h.client.close();
  }
});

function assertLeaksNothing(result: DispatchResult, label: string): void {
  const text = JSON.stringify(result);
  for (const leak of [
    SECRET_TEXT,
    "exportUrls",
    "/export",
    "counts",
    "settings",
    "redactionReport",
    "contentHash",
  ]) {
    assert.equal(text.includes(leak), false, `${label}: the refusal holds no ${leak}`);
  }
}

async function assertDatasetIntact(h: Harness): Promise<void> {
  assert.deepEqual(
    await h.counts(),
    { datasets: 1, rows: 2, links: 1 },
    "A's dataset, its rows and its lineage link are all still there",
  );
}

interface Harness {
  client: PGlite;
  datasetId: string;
  run: (
    auth: McpAuthContext,
    tool: string,
    params: Record<string, unknown>,
  ) => Promise<DispatchResult>;
  counts: () => Promise<{ datasets: number; rows: number; links: number }>;
}

async function seeded(): Promise<Harness> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG_A}', 'Org A', 'org-a'), ('${ORG_B}', 'Org B', 'org-b');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_A}', '${ORG_A}', 'A', 'a'), ('${PROJECT_B}', '${ORG_B}', 'B', 'b');
  `);
  const db = drizzle(client, { schema }) as unknown as Parameters<
    typeof createDrizzleDatasetStore
  >[0];
  const useCases = createDrizzleUseCaseStore(db as never);
  const created = await useCases.createUseCase(
    PROJECT_A,
    { name: "Triage", selector: { taskIds: ["triage"], intentIds: [] } },
    "user_a",
  );
  assert.ok(created.ok);
  const useCase = created.useCase;

  const datasets = createDrizzleDatasetStore(db);
  const settings = datasetSettings(
    useCase.selector,
    {
      filters: { noError: false, noSelfCorrection: false },
      dedup: "near",
      seed: 0,
      evalFraction: 0.1,
    },
    { since: new Date("2026-10-21T00:00:00Z"), until: new Date("2026-11-20T00:00:00Z") },
  );
  const building = await datasets.createBuilding(PROJECT_A, {
    useCaseId: useCase.id,
    settings,
    createdBy: "user_a",
  });
  const counts = {
    turns: 2,
    calls: 2,
    cursor: null,
    train: 1,
    eval: 1,
    dropped: emptyDrops(),
    exportSkipped: { train: 0, eval: 0 },
  };
  const row = (ordinal: number, side: "train" | "eval") => ({
    ordinal,
    side,
    content: {
      system: "Be brief.",
      messages: [{ role: "user" as const, content: `${SECRET_TEXT} ${ordinal}` }],
      output: [{ role: "assistant" as const, content: "ok" }],
    },
    rowHash: `hash-${ordinal}`,
    traceId: `trace-${ordinal}`,
    spanId: `span-${ordinal}`,
    turnId: "77777777-7777-4777-8777-77777777777" + ordinal,
    capturedAt: new Date("2026-11-19T00:00:00Z"),
  });
  assert.ok(
    await datasets.appendRows(PROJECT_A, building.id, [row(0, "train"), row(1, "eval")], {
      counts,
      redaction: emptyCounts(),
    }),
  );
  assert.ok(
    await datasets.markReady(PROJECT_A, building.id, {
      contentHash: "abc",
      counts,
      redaction: emptyCounts(),
    }),
  );
  await recordDatasetSource(PROJECT_A, building.id, useCase, db as never);

  const overrides = createDrizzleOverrideStore(db);
  const calls = createDrizzleModelCallSource(db as never);
  const refuse = (name: string) => async () => assert.fail(`${name} is not part of this test`);
  // Every collaborator a dataset tool reads takes the project id: the real stores filter by it.
  const deps: FineTuningOperationDeps = {
    fineTuningEnabled: async () => true,
    listUseCases: (projectId, options) => useCases.listUseCases(projectId, options),
    getUseCase: (projectId, id) => useCases.getUseCase(projectId, id),
    createUseCase: refuse("createUseCase"),
    useCaseStats: (projectId, found) =>
      loadUseCaseStats(projectId, found.selector, calls, new Date("2026-11-20T00:00:00Z")),
    track: async () => {},
    buildDataset: refuse("buildDataset"),
    getDataset: (projectId, id) => datasets.getDataset(projectId, id),
    listRows: (projectId, id, query) => datasets.listRows(projectId, id, query),
    listOverrides: (projectId, useCaseId) => overrides.listOverrides(projectId, useCaseId),
    setOverride: (projectId, useCaseId, input, actor) =>
      overrides.setOverride(projectId, useCaseId, input, actor),
    trackOverride: async () => {},
    deleteDataset: (projectId, id) => datasets.delete(projectId, id),
    trackLifecycle: async () => {},
    contentAccess: { contentOptIn: async () => true },
  };
  const registry = buildRegistry(fineTuningOperations(deps));
  const projectOwner = async (projectId: string) => {
    const { rows } = await client.query<{ organization_id: string }>(
      "select organization_id from projects where id = $1",
      [projectId],
    );
    return rows[0] ? { organizationId: rows[0].organization_id } : null;
  };
  const count = async (sql: string) =>
    (await client.query<{ n: number }>(sql, [building.id])).rows[0]!.n;
  return {
    client,
    datasetId: building.id,
    run: (auth, tool, params) => dispatchOperation(tool, params, { registry, auth, projectOwner }),
    counts: async () => ({
      datasets: await count("select count(*)::int as n from fine_tuning_datasets where id = $1"),
      rows: await count(
        "select count(*)::int as n from fine_tuning_dataset_rows where dataset_id = $1",
      ),
      links: await count(
        "select count(*)::int as n from lineage_links where kind = 'dataset' and object_id = $1::text",
      ),
    }),
  };
}
