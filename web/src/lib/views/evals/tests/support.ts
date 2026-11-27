import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { Scorer } from "@/lib/views/scorers/types";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import type { CaseContent, EvalCase } from "../domain/case";
import type { EvalContent, EvalDefinition, EvalScorer } from "../domain/eval";
import type { CaseStore, NewCase } from "../ports/case-store";
import type { DatasetSources } from "../ports/dataset-sources";

export const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

/** A migrated database with two projects of one organization. */
export async function createEvalsDb() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  // biome-ignore lint/suspicious/noExplicitAny: PGlite stands in for the Postgres client
  return { client, db: drizzle(client, { schema }) as any };
}

export const NO_REFUND: EvalScorer = {
  id: "no-refund",
  name: "No refund",
  gating: true,
  definition: { kind: "check", config: { path: "tools", op: "ne", value: "refund_order" } },
};

export function content(over: Partial<CaseContent> = {}): CaseContent {
  return {
    input: { message: "refund A200" },
    earlierTurns: [],
    toolFixtures: [],
    expectedOutput: null,
    ...over,
  };
}

export function evalContent(over: Partial<EvalContent> = {}): EvalContent {
  return {
    datasetId: null,
    sandboxName: null,
    sandboxVersionId: null,
    params: {},
    matrix: {},
    trials: 3,
    scorers: [NO_REFUND],
    ...over,
  };
}

/** An eval of the project, with `NO_REFUND` unless the content says other scorers. */
export async function seedEval(
  // biome-ignore lint/suspicious/noExplicitAny: the drizzle database of `createEvalsDb`
  db: any,
  over: { name?: string; projectId?: string; content?: Partial<EvalContent> } = {},
): Promise<EvalDefinition> {
  const created = await createDrizzleEvalStore(db).create({
    projectId: over.projectId ?? PROJECT_ID,
    name: over.name ?? "Refunds",
    taskId: null,
    content: evalContent(over.content),
    createdBy: "user_1",
  });
  if (typeof created === "string") throw new Error(`the eval was not created: ${created}`);
  return created;
}

/** A case store whose `create` puts a case into this eval unless the input names another one. */
export function inEval(
  store: CaseStore,
  evalId: string,
): Omit<CaseStore, "create"> & {
  create(input: Omit<NewCase, "evalId"> & { evalId?: string }): Promise<EvalCase>;
} {
  return {
    ...store,
    async create(input) {
      const made = await store.create({ evalId, ...input });
      if (typeof made === "string") throw new Error(`the case was not created: ${made}`);
      return made;
    },
  };
}

/** Dataset sources that read nothing: a test of a query dataset gives its own. */
export function noSources(over: Partial<DatasetSources> = {}): DatasetSources {
  return {
    readContent: async () => true,
    newestTurns: async () => [],
    taskTurns: async () => [],
    rqlTraces: async () => ({ ok: true, traceIds: [], truncated: false }),
    turnsOfTraces: async () => [],
    chooseCandidates: async () => [],
    chooseForTask: async () => [],
    turnRow: async () => null,
    ...over,
  };
}

/** The deps of datasets, sources and the library over the test database. */
export function modelDeps(
  // biome-ignore lint/suspicious/noExplicitAny: the drizzle database of `createEvalsDb`
  db: any,
  over: { sources?: Partial<DatasetSources>; projectScorers?: Scorer[] } = {},
) {
  return {
    datasets: createDrizzleDatasetStore(db),
    sources: noSources(over.sources),
    library: { projectScorers: async () => over.projectScorers ?? [] },
  };
}
