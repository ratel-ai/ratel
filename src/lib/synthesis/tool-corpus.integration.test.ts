import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite, organizations } from "@/lib/platform/db/test-support";
import { projects } from "@/lib/platform/projects/schema";
import { createToolCorpus } from "./tool-corpus";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER = "22222222-2222-4222-8222-222222222223";

test("the core tool corpus is the project's tools, override applied, identity kept", async () => {
  const client = await createMigratedPGlite();
  try {
    const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
    await db.insert(organizations).values({ id: ORG, name: "Org", slug: "org" });
    await db.insert(projects).values([
      { id: PROJECT, organizationId: ORG, name: "P", slug: "p" },
      { id: OTHER, organizationId: ORG, name: "O", slug: "o" },
    ]);
    const row = (projectId: string, kind: string, entryId: string, override: string | null) => ({
      projectId,
      kind,
      entryId,
      name: entryId,
      description: `Does ${entryId}.`,
      tags: ["t"],
      searchableDescription: `search ${entryId}`,
      searchableDescriptionOverridden: override !== null,
      useCloudDefinitions: false,
      searchableDescriptionOverride: override,
      contentHash: `h-${entryId}`,
    });
    await db
      .insert(runtimeCatalogEntries)
      .values([
        row(PROJECT, "tool", "refund_payment", "refund money back"),
        row(PROJECT, "tool", "send_email", null),
        row(PROJECT, "skill", "a_skill", null),
        row(OTHER, "tool", "elsewhere", null),
      ]);

    const corpus = await createToolCorpus(db).load(PROJECT);
    const byId = Object.fromEntries(corpus.map((entry) => [entry.entryId, entry]));
    assert.deepEqual(Object.keys(byId).sort(), ["refund_payment", "send_email"]);
    assert.deepEqual(byId.refund_payment, {
      entryId: "refund_payment",
      name: "refund_payment",
      searchable: "refund money back",
      description: "Does refund_payment.",
      runtimeSearchable: "search refund_payment",
      source: "override",
      matchesAgentDescription: false,
      tags: ["t"],
    });
    assert.equal(byId.send_email?.searchable, "search send_email");
    assert.equal(byId.send_email?.source, "runtime");
  } finally {
    await client.close();
  }
});
