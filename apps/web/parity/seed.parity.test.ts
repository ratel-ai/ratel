import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { LOCAL_ORGANIZATION_ID } from "@/lib/adapters/oss/session";
import { seedSiteCopilot } from "@/lib/console/seed/site-copilot-seed";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { SEED } from "./inputs";
import { parity } from "./ledger";
import { golden, same } from "./support";

// Item 12: the Site Copilot seed. The same plan at the same instant is seeded into an empty
// database, and what it stores is counted by type against what Cloud's seed stores.

interface CloudSeed {
  stored: { otelSpans: number; events: number; traceEvents: Record<string, number> };
}
const cloud = golden<CloudSeed>("seed-plan");

parity(
  12,
  "the Site Copilot seed stores the trace events Cloud's stores, type by type",
  async () => {
    const client = await createMigratedPGlite();
    try {
      await client.exec(
        `insert into organizations (id, name, slug) values ('${LOCAL_ORGANIZATION_ID}', 'Acme', 'acme')`,
      );
      const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
      await seedSiteCopilot(
        {
          organizationId: LOCAL_ORGANIZATION_ID,
          seed: SEED.seed,
          turns: SEED.turns,
          anchorMs: Date.parse(SEED.anchor),
        },
        db,
      );
      const count = async (query: ReturnType<typeof sql>) =>
        (await db.execute<{ n: number }>(query)).rows[0]?.n ?? 0;
      const types = await db.execute<{ type: string; n: number }>(
        sql`select type, count(*)::int as n from trace_events group by type order by type`,
      );
      same(
        {
          otelSpans: await count(sql`select count(*)::int as n from otel_spans`),
          events: await count(sql`select count(*)::int as n from events`),
          traceEvents: Object.fromEntries(types.rows.map((row) => [row.type, row.n])),
        },
        {
          otelSpans: cloud.stored.otelSpans,
          events: cloud.stored.events,
          traceEvents: cloud.stored.traceEvents,
        },
      );
    } finally {
      await client.close();
    }
  },
);
