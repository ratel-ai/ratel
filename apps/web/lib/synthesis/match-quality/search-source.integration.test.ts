import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { organizations } from "@/lib/platform/identity/schema";
import { projects } from "@/lib/platform/projects/schema";
import { listSearchTelemetryProjects } from "./search-source";

const ORG = "11111111-1111-4111-8111-111111111111";
const IN_WINDOW = "22222222-2222-4222-8222-222222222221";
const OUT_OF_WINDOW = "22222222-2222-4222-8222-222222222222";
const NO_QUERY = "22222222-2222-4222-8222-222222222223";
const NO_OCCURRED_AT = "22222222-2222-4222-8222-222222222224";
const OTHER_TYPE = "22222222-2222-4222-8222-222222222225";
const window = { since: new Date("2026-10-01T00:00:00Z"), until: new Date("2026-10-28T00:00:00Z") };

test("only projects with a search that has text and an event time inside the window are candidates", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await db.insert(organizations).values({ id: ORG, name: "Org", slug: "org" });
  const ids = [IN_WINDOW, OUT_OF_WINDOW, NO_QUERY, NO_OCCURRED_AT, OTHER_TYPE];
  await db
    .insert(projects)
    .values(ids.map((id, i) => ({ id, organizationId: ORG, name: `P${i}`, slug: `p${i}` })));
  const event = (projectId: string, n: number, over: Partial<typeof traceEvents.$inferInsert>) => ({
    id: `33333333-3333-4333-8333-33333333333${n}`,
    projectId,
    type: "search",
    clientEventId: `e${n}`,
    query: "refund an order",
    occurredAt: new Date("2026-10-10T00:00:00Z"),
    receivedAt: new Date("2026-10-10T00:00:01Z"),
    payload: {},
    ...over,
  });
  await db.insert(traceEvents).values([
    event(IN_WINDOW, 1, {}),
    event(OUT_OF_WINDOW, 2, {
      occurredAt: new Date("2026-09-01T00:00:00Z"),
      receivedAt: new Date("2026-09-01T00:00:01Z"),
    }),
    event(NO_QUERY, 3, { query: null }),
    // Received inside the window but with no event time: not a candidate, as before.
    event(NO_OCCURRED_AT, 4, { occurredAt: null }),
    event(OTHER_TYPE, 5, { type: "skill_invoke" }),
  ]);

  assert.deepEqual(await listSearchTelemetryProjects(window, db), [IN_WINDOW]);
  await client.close();
});
