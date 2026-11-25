import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { CaseContent, CaseScorer } from "../domain/case";

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

export const NO_REFUND: CaseScorer = {
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
    scorers: [NO_REFUND],
    ...over,
  };
}
