import assert from "node:assert/strict";
import { test } from "node:test";
import { planSiteCopilot } from "@/lib/console/seed/site-copilot-plan";
import { SITE_TOPICS } from "@/lib/console/seed/site-copilot-turns";
import { parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { siteCopilotSearchEvents } from "./site-copilot-searches";

const ANCHOR = Date.UTC(2026, 9, 20, 15, 0, 0);
const DAY_MS = 86_400_000;
const plan = planSiteCopilot({ turns: 300 });
const events = siteCopilotSearchEvents(plan, { anchorMs: ANCHOR });
const turns = plan.conversations.flatMap((c) => c.turns);

test("the agent searches once for each turn that opens a topic and calls a tool", () => {
  const topics: readonly string[] = SITE_TOPICS;
  const searched = turns.filter((turn) => topics.includes(turn.kind) && turn.calls.length > 0);
  assert.ok(searched.length > 0);
  assert.deepEqual(
    events.map((event) => event.query),
    searched.map((turn) => turn.ask),
  );
});

test("a follow-up is not a search, so it is never offered as a real prompt", () => {
  const queries = events.map((event) => event.query.toLowerCase());
  assert.ok(!queries.some((query) => query.includes("thank") || query === "try again?"));
});

test("every event passes ingest validation", () => {
  const { valid, rejected } = parseTraceEvents(events);
  assert.equal(rejected.length, 0);
  assert.equal(valid.length, events.length);
});

test("every event falls in the window and has its own id", () => {
  for (const event of events) {
    assert.ok(event.ts <= ANCHOR);
    assert.ok(event.ts >= ANCHOR - 30 * DAY_MS);
  }
  assert.equal(new Set(events.map((event) => event.client_event_id)).size, events.length);
});

test("the same plan and anchor give the same events", () => {
  assert.deepEqual(siteCopilotSearchEvents(plan, { anchorMs: ANCHOR }), events);
});
