import assert from "node:assert/strict";
import { test } from "node:test";
import { setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { BARE, CHAT, ingestSessionUserExport, ROOT } from "./test-support";

/**
 * Session and end-user ids on `otel_spans` (RTL-321): an OTLP export POSTed to
 * the traces route, then the span columns read back next to the `trace_events`
 * rows the same export made. Both tables carry the same values.
 */

test("each span stores the session and end user of its export, with the trace_events values", async () => {
  const { client, db } = await setupDb();
  await ingestSessionUserExport(db);
  const spans = await client.query(
    `select span_id, session_id, end_user_id from otel_spans order by span_id`,
  );
  assert.deepEqual(spans.rows, [
    { span_id: ROOT, session_id: "conv-42", end_user_id: "user-7" },
    // The child reads them from its root, as the trace_events row does.
    { span_id: CHAT, session_id: "conv-42", end_user_id: "user-7" },
    // No session and no user anywhere: null, not the trace id stand-in of trace_events.
    { span_id: BARE, session_id: null, end_user_id: null },
  ]);
  const events = await client.query(
    `select span_id, session_id, end_user_id from trace_events where span_id = $1`,
    [CHAT],
  );
  assert.deepEqual(events.rows, [{ span_id: CHAT, session_id: "conv-42", end_user_id: "user-7" }]);
  await client.close();
});
