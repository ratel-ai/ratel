import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { McpErrorBody as DispatchFailure } from "@/lib/mcp/errors";
import { assembleOperations } from "@/lib/mcp/operations";
import { ASK_LIMITS, ASK_MODEL } from "@/lib/views/ask/limits";
import type { AskModel } from "@/lib/views/ask/model";
import { askRequests } from "@/lib/views/ask/schema";
import { getDashboards } from "@/lib/views/dashboards/store";
import { askOperations } from "./ask";
import { insertTrace, type Monitoring, monitoring, NOW, PROJECT } from "./test-support";

const GOOD = {
  title: "Traces per hour",
  rql: "select time_bucket('1 hour', started_at) as hour, count(*) as traces from traces group by hour order by hour",
  chart: "line",
};
const BROKEN = { title: "Broken", rql: "select nothing from nowhere", chart: "bar" };

let m: Monitoring;
let calls = 0;
const model: AskModel = {
  model: ASK_MODEL,
  standIn: false,
  async complete() {
    calls += 1;
    return {
      text: JSON.stringify({
        widgets: calls % 2 === 1 ? [GOOD, BROKEN] : [BROKEN],
        range: calls % 2 === 1 ? "14d" : "",
      }),
      usage: { inputTokens: 500, outputTokens: 100 },
    };
  },
};
let current: AskModel | null = model;

beforeEach(async () => {
  calls = 0;
  current = model;
  m = await monitoring((deps) =>
    askOperations(
      deps,
      () => ({ model: current }),
      () => ({ engine: null }),
    ),
  );
});

test("draft_widgets drafts checked widgets, names the broken one and saves no dashboard", async () => {
  const data = await m.data<{
    askId: string;
    widgets: { title: string; chart: string; query: { kind: string; text: string } }[];
    refused: { title: string; reason: string }[];
    range: string | null;
  }>("draft_widgets", { words: "How busy are my agents over the last 14 days?" });
  // The range the words name, for import_dashboard; the repair round does not change it.
  assert.equal(data.range, "14d");
  assert.deepEqual(
    data.widgets.map(({ title, chart, query }) => [title, chart, query.kind]),
    [[GOOD.title, "line", "sql"]],
  );
  assert.deepEqual(
    data.refused.map(({ title }) => title),
    [BROKEN.title],
  );
  assert.deepEqual(await getDashboards(PROJECT, undefined, m.db), []);
  const rows = await m.db.select().from(askRequests);
  assert.deepEqual(
    rows.map(({ id, surface, outcome }) => [id, surface, outcome]),
    [[data.askId, "mcp", null]],
  );
});

test("draft_widgets is refused with customMonitoring off, and is not listed", async () => {
  m.set.on = false;
  const result = (await m.call("draft_widgets", { words: "errors" })) as DispatchFailure;
  assert.equal(result.ok, false);
  assert.equal(result.error, "forbidden");
  assert.equal(calls, 0);
  const ids = (on: boolean) => assembleOperations({ customMonitoring: on }).map(({ id }) => id);
  assert.ok(ids(true).includes("draft_widgets"));
  assert.ok(!ids(false).includes("draft_widgets"));
});

test("draft_widgets counts against the same limits as the console", async () => {
  await m.db.insert(askRequests).values(
    Array.from({ length: ASK_LIMITS.draftsPerPersonPerMinute }, () => ({
      projectId: PROJECT,
      actor: `project:${PROJECT}`,
      surface: "console" as const,
      target: "widget" as const,
      words: "w",
      model: ASK_MODEL,
      createdAt: new Date(NOW.getTime() - 5_000),
    })),
  );
  const result = (await m.call("draft_widgets", { words: "errors" })) as DispatchFailure & {
    reason?: string;
    retryAfterSeconds?: number;
  };
  assert.equal(result.ok, false);
  assert.equal(result.error, "rate_limited");
  assert.equal(result.reason, "person_per_minute");
  assert.equal(result.retryAfterSeconds, 55);
  assert.equal(calls, 0);
});

test("draft_widgets with no model key says not_set_up", async () => {
  current = null;
  const result = (await m.call("draft_widgets", { words: "errors" })) as DispatchFailure & {
    reason?: string;
  };
  assert.equal(result.error, "unavailable");
  assert.equal(result.reason, "not_set_up");
});

test("draft_widgets for a widget needs the dashboard", async () => {
  const result = (await m.call("draft_widgets", {
    words: "errors",
    target: "widget",
  })) as DispatchFailure;
  assert.equal(result.error, "invalid_params");
  assert.equal(calls, 0);
});

test("suggest_prompts gives the fixed order with no engine, and is refused with the flag off", async () => {
  assert.deepEqual(await m.data("suggest_prompts", {}), { prompts: [], source: "fixed" });
  await insertTrace(m.client, "c".repeat(32));
  const data = await m.data<{ prompts: string[]; source: string }>("suggest_prompts", {});
  assert.equal(data.source, "fixed");
  assert.ok(data.prompts.length > 0 && data.prompts.length <= 4);
  m.set.on = false;
  const result = (await m.call("suggest_prompts", {})) as DispatchFailure;
  assert.equal(result.error, "forbidden");
});
