import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { fresh } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { loadHallucinationsPage } from "@/lib/views/health/hallucinations/page-load";
import { loadToolNames, toolNameCheck } from "@/lib/views/health/hallucinations/tool-names";

const BASE = Date.parse("2026-09-01T09:00:00Z");
const window = { from: new Date("2026-08-25T00:00:00Z"), to: new Date("2026-09-02T00:00:00Z") };

test("tool names are read per tool from the window's closed turns, and the page counts them as the tool check", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [
    fresh({ session: "s-1", start: BASE })
      .invoke("read_file")
      .invoke("missing_tool")
      .error("missing_tool"),
    fresh({ session: "s-2", start: BASE + 60_000 }).invoke("read_file"),
  ]);
  const rows = await loadToolNames(PROJECT_ID, window, db as never);
  assert.deepEqual(toolNameCheck(rows), { calls: 3, callsOnWorking: 2 });

  // No error text and no asked-for name: the tool group is checked by name alone.
  await client.query(
    `update trace_events set error_message = 'tool_error' where error_message is not null`,
  );
  const page = await loadHallucinationsPage({
    projectId: PROJECT_ID,
    windowDays: 7,
    query: { group: null, kind: null },
    now: window.to,
    db: db as never,
  });
  assert.deepEqual(page.toolNames, { calls: 3, callsOnWorking: 2 });
  const unchecked = Object.fromEntries(page.groups.map((g) => [g.group, g.unchecked !== null]));
  assert.deepEqual(unchecked, { tool: false, input: true, completion: true });
});

test("with the asked-for name in the traces the rules check tools, and no name list is loaded", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [fresh({ session: "s-1", start: BASE }).invoke("read_file")]);
  await client.query(
    `update trace_events set payload = payload || jsonb_build_object('requested_tool_id', 'read')`,
  );
  const page = await loadHallucinationsPage({
    projectId: PROJECT_ID,
    windowDays: 7,
    query: { group: null, kind: null },
    now: window.to,
    db: db as never,
  });
  assert.equal(page.toolNames, null);
});
