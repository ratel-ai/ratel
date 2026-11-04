import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import {
  pruneExpiredRuntimeEventRejects,
  pruneExpiredRuntimeEvents,
  type RuntimeEventMaintenanceDb,
} from "@/lib/ingest/trace-events/maintenance";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-13T00:00:00.000Z");

test("retention prunes runtime facts after 30d and reject metadata after 7d", async () => {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG_ID}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORG_ID}', 'P', 'p');
     insert into trace_events
       (id, project_id, type, client_event_id, payload, ingest_source, received_at)
     values
       ('10000000-0000-4000-8000-000000000001', '${PROJECT_ID}', 'future', 'old-runtime', '{}', 'runtime', '2026-07-13'),
       ('10000000-0000-4000-8000-000000000002', '${PROJECT_ID}', 'future', 'new-runtime', '{}', 'runtime', '2026-08-12'),
       ('10000000-0000-4000-8000-000000000003', '${PROJECT_ID}', 'search', 'old-otlp', '{}', 'otlp', '2026-07-13');
     insert into trace_event_rejects
       (project_id, event_id, type, reason, size_bytes, received_at)
     values
       ('${PROJECT_ID}', 'old-reject', 'search', 'bad', 10, '2026-08-05'),
       ('${PROJECT_ID}', 'new-reject', 'search', 'bad', 10, '2026-08-12');`,
  );
  const db = drizzle(client, { schema }) as unknown as RuntimeEventMaintenanceDb;

  assert.equal(await pruneExpiredRuntimeEvents({ now: NOW }, db), 1);
  assert.equal(await pruneExpiredRuntimeEventRejects({ now: NOW }, db), 1);

  const events = await client.query<{ client_event_id: string }>(
    `select client_event_id from trace_events order by client_event_id`,
  );
  assert.deepEqual(
    events.rows.map(({ client_event_id }) => client_event_id),
    ["new-runtime", "old-otlp"],
  );
  const rejects = await client.query<{ event_id: string }>(
    `select event_id from trace_event_rejects order by event_id`,
  );
  assert.deepEqual(
    rejects.rows.map(({ event_id }) => event_id),
    ["new-reject"],
  );
});
