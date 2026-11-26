import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { DEFAULT_GEO_ATTRIBUTES } from "@/lib/ingest/geo/attributes";
import { loadGeoAttributes } from "@/lib/ingest/geo/store";
import { changeAlert } from "@/lib/views/alerts/actions";
import { getAlertRule, listAlertRules } from "@/lib/views/alerts/store";
import { changeScorer } from "@/lib/views/scorers/actions";
import {
  countScorers,
  createScorer,
  getScorer,
  insertTraceScores,
  listScorers,
} from "@/lib/views/scorers/store";
import { saveSlackConnection } from "@/lib/views/slack/store";
import { alertReadOperations, alertWriteOperations } from "./alerts";
import { locationReadOperations, locationWriteOperations } from "./locations";
import { scorerReadOperations, scorerWriteOperations } from "./scorers";
import {
  insertTrace,
  KEY_AUTH,
  type Monitoring,
  monitoring,
  NOW,
  ORG,
  OTHER,
  PROJECT,
  personAuth,
  SECRET_KEY,
} from "./test-support";

const MISSING = "44444444-4444-4444-8444-444444444444";
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/verysecretpart";
const TOKEN = "xoxb-very-secret-token";
const CHECK = {
  name: "Fast",
  kind: "check",
  config: { path: "duration_ms", op: "lte", value: 200 },
};
const ALERT = {
  name: "Errors",
  query: {
    version: 1,
    kind: "metric",
    measures: [{ measure: "error_rate", aggregation: "rate" }],
  },
  operator: "above",
  threshold: 0.05,
  windowMinutes: 15,
};
/** Every operation, with params that reach its work. */
const CALLS: readonly [string, object][] = [
  ["list_scorers", {}],
  ["get_scorer", { scorerId: MISSING }],
  ["test_scorer", { scorer: CHECK }],
  ["change_scorer", { action: "create", scorer: CHECK }],
  ["list_alerts", {}],
  ["get_alert", { alertId: MISSING }],
  ["change_alert", { action: "create", alert: ALERT }],
  ["list_alert_destinations", {}],
  ["change_alert_destination", { action: "add_channel", channelId: "C0123456789" }],
  ["list_slack_channels", {}],
  ["get_location_attributes", {}],
];

let m: Monitoring;
before(async () => {
  m = await monitoring((deps) => [
    ...scorerReadOperations(deps),
    ...alertReadOperations(deps),
    ...locationReadOperations(deps),
    ...locationWriteOperations(deps),
    ...scorerWriteOperations(deps),
    ...alertWriteOperations(deps),
  ]);
});
beforeEach(async () => {
  await m.client.exec(
    "delete from trace_scorers; delete from alert_rules; delete from alert_destinations; delete from slack_connections; delete from otel_trace_summaries",
  );
  m.set.on = true;
  m.set.channels = { ok: true, channels: [], partial: false };
  m.set.access = { ok: true, teamId: "T1", name: "alerts" };
  m.set.post = { ok: true };
  m.events.length = 0;
  m.posted.length = 0;
});
after(() => m.client.close());

test("with the flag off every operation refuses and writes nothing", async () => {
  m.set.on = false;
  for (const [id, params] of CALLS) {
    const result = await m.call(id, params);
    assert.equal(!result.ok && result.error, "forbidden", id);
    assert.equal(!result.ok && result.reason, "custom_monitoring_off", id);
  }
  assert.deepEqual(m.events, []);
  assert.deepEqual(await listScorers(PROJECT, m.db), []);
  assert.deepEqual(await listAlertRules(PROJECT, m.db), []);
});

test("with the flag on every operation works for a key and for a member", async () => {
  for (const [id, params] of CALLS) {
    const expected = id === "get_scorer" || id === "get_alert" ? "not_found" : true;
    const keyed = await m.call(id, params);
    assert.equal(keyed.ok || keyed.error, expected, id);
  }
  await m.client.exec("delete from alert_destinations");
  for (const [id, params] of CALLS) {
    const expected = id === "get_scorer" || id === "get_alert" ? "not_found" : true;
    const asked = await m.call(id, { ...params, projectId: PROJECT }, personAuth());
    assert.equal(asked.ok || asked.error, expected, id);
  }
});

test("without access to the project every operation refuses", async () => {
  const readOnly = { ...KEY_AUTH, scopes: ["ingest:write"] } as typeof KEY_AUTH;
  for (const [id, params] of CALLS) {
    const other = await m.call(id, { ...params, projectId: OTHER });
    assert.equal(!other.ok && other.error, "forbidden", id);
    const stranger = await m.call(
      id,
      { ...params, projectId: PROJECT },
      personAuth("admin", MISSING),
    );
    assert.equal(!stranger.ok && stranger.error, "not_found", id);
    const ingest = await m.call(id, params, readOnly);
    assert.equal(!ingest.ok && ingest.error, "forbidden", id);
  }
  assert.deepEqual(m.events, []);
});

test("F445-9: the scorer over the limit is refused as the console refuses it", async () => {
  await m.client.exec(`insert into trace_scorers (project_id, name, kind, config, created_by, updated_by)
    select '${PROJECT}', 'S' || n, 'check', '{"path":"duration_ms","op":"exists"}', 'u', 'u' from generate_series(1, 99) n`);
  const create = () => m.call("change_scorer", { action: "create", scorer: CHECK });
  assert.ok((await create()).ok);
  const over = await create();
  assert.deepEqual(!over.ok && [over.error, over.message], [
    "conflict",
    "This project has 100 scorers, and the limit is 100. Delete 1 to create another.",
  ]);
  assert.equal(await countScorers(PROJECT, m.db), 100);
  // The other actions stay.
  const [first] = await listScorers(PROJECT, m.db);
  assert.ok((await m.call("change_scorer", { action: "disable", scorerId: first?.id })).ok);
});

test("over the limit (legacy excess), change_scorer refuses create with the real count; the rest works", async () => {
  await m.client.exec(`insert into trace_scorers (project_id, name, kind, config, created_by, updated_by)
    select '${PROJECT}', 'S' || n, 'check', '{"path":"duration_ms","op":"exists"}', 'u', 'u' from generate_series(1, 120) n`);
  const over = await m.call("change_scorer", { action: "create", scorer: CHECK });
  assert.deepEqual(!over.ok && [over.error, over.message], [
    "conflict",
    "This project has 120 scorers, and the limit is 100. Delete 21 to create another.",
  ]);
  const [first] = await listScorers(PROJECT, m.db);
  const scorerId = first?.id;
  for (const params of [
    { action: "update", scorerId, scorer: { name: "Renamed" } },
    { action: "disable", scorerId },
    { action: "enable", scorerId },
    { action: "attach", scorerId, taskId: "t1", narrow: true },
    { action: "delete", scorerId },
  ])
    assert.ok((await m.call("change_scorer", params)).ok, params.action);
  assert.equal(await countScorers(PROJECT, m.db), 119);
});

test("a scorer made through MCP equals the one the web app makes", async () => {
  const { scorerId } = await m.data<{ scorerId: string }>("change_scorer", {
    action: "create",
    scorer: CHECK,
  });
  const web = await changeScorer(
    {
      projectId: PROJECT,
      action: "create",
      draft: { ...CHECK, filter: {}, tasks: null, sampleRate: 100, enabled: true },
    },
    {
      getSession: async () => ({ user: { id: "u", externalId: "u" } }),
      findProjectScope: async () => ({ project: { id: PROJECT }, organization: { id: ORG } }),
      enabled: async () => true,
      isRestricted: async () => false,
      get: async () => null,
      count: async () => 0,
      create: (project, draft, actor) => createScorer(project, draft, actor, m.db),
      update: async () => false,
      setEnabled: async () => false,
      remove: async () => false,
      attach: async () => false,
      detach: async () => false,
      observe: async () => {},
    },
  );
  assert.ok(web.ok);
  const [byMcp, byWeb] = await Promise.all([
    getScorer(PROJECT, scorerId, m.db),
    getScorer(PROJECT, web.scorerId, m.db),
  ]);
  const same = (scorer: typeof byMcp) => {
    assert.ok(scorer);
    const { id: _, createdAt: __, updatedAt: ___, ...rest } = scorer;
    return rest;
  };
  assert.deepEqual(same(byMcp), same(byWeb));
  assert.deepEqual(m.events, [
    {
      event: "feature.scorers.changed",
      fields: {
        project_id: PROJECT,
        organization_id: ORG,
        scorer_id: scorerId,
        kind: "check",
        actor: `project:${PROJECT}`,
        action: "create",
        surface: "mcp",
      },
    },
  ]);
});

test("change_scorer creates, updates and attaches each task preset; judge_criteria is a judge", async () => {
  const presets: { preset: string; max?: number; tool?: string }[] = [
    { preset: "ends_well" },
    { preset: "max_self_corrections", max: 1 },
    { preset: "max_latency_ms", max: 2000 },
    { preset: "max_cost_usd", max: 0.1 },
    { preset: "expected_tool", tool: "book" },
    { preset: "max_tool_calls", max: 3 },
  ];
  for (const config of presets) {
    const { scorerId } = await m.data<{ scorerId: string }>("change_scorer", {
      action: "create",
      scorer: { name: config.preset, kind: "preset", config, tasks: ["t1"] },
    });
    const changed = config.max === undefined ? config : { ...config, max: config.max + 1 };
    await m.data("change_scorer", {
      action: "update",
      scorerId,
      scorer: { kind: "preset", config: changed },
    });
    await m.data("change_scorer", { action: "attach", scorerId, taskId: "t2" });
    const stored = await getScorer(PROJECT, scorerId, m.db);
    assert.deepEqual(
      [stored?.kind, stored?.config, stored?.tasks],
      ["preset", changed, ["t1", "t2"]],
      config.preset,
    );
  }
  const { scorerId } = await m.data<{ scorerId: string }>("change_scorer", {
    action: "create",
    scorer: {
      name: "Criteria",
      kind: "preset",
      config: { preset: "judge_criteria", criteria: "Did it book?" },
      tasks: ["t1"],
    },
  });
  const judge = await getScorer(PROJECT, scorerId, m.db);
  assert.deepEqual(
    [judge?.kind, judge?.config],
    ["judge", { prompt: "Did it book?", output: "boolean" }],
  );
  const listed = await m.data<{
    scorers: { usage: { tasks: number; total: number; said: string } }[];
  }>("list_scorers", {});
  assert.deepEqual(
    [listed.scorers[0]?.usage.tasks, listed.scorers[0]?.usage.said],
    [2, "used in 2 places"],
  );
  const everyTrace = await m.call("change_scorer", {
    action: "create",
    scorer: { name: "No task", kind: "preset", config: { preset: "ends_well" } },
  });
  assert.equal(everyTrace.ok, false);
  assert.match(everyTrace.ok ? "" : everyTrace.message, /tasks/);
});

test("a scorer is listed, read, updated, switched, attached, detached and deleted", async () => {
  const { scorerId } = await m.data<{ scorerId: string }>("change_scorer", {
    action: "create",
    scorer: CHECK,
  });
  const change = (action: string, rest: object = {}) =>
    m.data("change_scorer", { action, scorerId, ...rest });
  await change("update", { scorer: { name: "Faster", sampleRate: 50 } });
  let stored = await getScorer(PROJECT, scorerId, m.db);
  assert.deepEqual(
    [stored?.name, stored?.sampleRate, stored?.config],
    ["Faster", 50, CHECK.config],
    "an update keeps what it does not give",
  );
  await change("disable");
  assert.equal((await getScorer(PROJECT, scorerId, m.db))?.enabled, false);
  await change("enable");

  const refused = await m.call("change_scorer", { action: "attach", scorerId, taskId: "t1" });
  assert.equal(!refused.ok && refused.error, "conflict");
  assert.match(refused.ok ? "" : refused.message, /Pass narrow: true/);
  await change("attach", { taskId: "t1", narrow: true });
  await change("attach", { taskId: "t2" });
  await change("detach", { taskId: "t1" });
  stored = await getScorer(PROJECT, scorerId, m.db);
  assert.deepEqual([stored?.enabled, stored?.tasks], [true, ["t2"]]);

  await insertTraceScores(
    [
      { traceId: "a", passed: true, value: 1 },
      { traceId: "b", passed: false, value: 0 },
    ].map((score) => ({
      ...score,
      scorerId,
      projectId: PROJECT,
      confidence: null,
      traceStartedAt: new Date(NOW.getTime() - 3_600_000),
    })),
    m.db,
  );
  const list = await m.data<{ scorers: Record<string, unknown>[] }>("list_scorers");
  assert.deepEqual(list.scorers[0].last7Days, { scored: 2, passRate: 0.5, average: 0.5 });
  const read = await m.data<{ latest: { result: string }[]; trend: object[] }>("get_scorer", {
    scorerId,
  });
  assert.deepEqual(read.latest.map(({ result }) => result).sort(), ["Fail", "Pass"]);
  assert.deepEqual(read.trend, [{ day: "2026-11-24", scored: 2, passRate: 0.5, average: 0.5 }]);

  await change("delete");
  assert.equal(await getScorer(PROJECT, scorerId, m.db), null);
});

test("a test runs a draft or a saved scorer on recent traces and stores nothing", async () => {
  await insertTrace(m.client, "fast", 100);
  await insertTrace(m.client, "slow", 900);
  const draft = await m.data<{
    matchingTracesLast7Days: number;
    results: { traceId: string; result: string }[];
  }>("test_scorer", { scorer: CHECK });
  assert.equal(draft.matchingTracesLast7Days, 2);
  assert.deepEqual(
    draft.results.map(({ traceId, result }) => [traceId, result]),
    [
      ["fast", "Pass"],
      ["slow", "Fail"],
    ],
  );
  const { scorerId } = await m.data<{ scorerId: string }>("change_scorer", {
    action: "create",
    scorer: CHECK,
  });
  const saved = await m.data<{ results: object[] }>("test_scorer", { scorerId });
  assert.equal(saved.results.length, 2);
  const stored = await m.client.query("select 1 from trace_scores");
  assert.equal(stored.rows.length, 0);
});

test("an alert made through MCP equals the one the web app makes", async () => {
  const { alertId } = await m.data<{ alertId: string }>("change_alert", {
    action: "create",
    alert: ALERT,
  });
  const store = await import("@/lib/views/alerts/store");
  const web = await changeAlert(
    { projectId: PROJECT, action: "create", draft: ALERT },
    {
      getSession: async () => ({ user: { id: "u", externalId: "u" } }),
      findProjectScope: async () => ({ project: { id: PROJECT }, organization: { id: ORG } }),
      enabled: async () => true,
      isRestricted: async () => false,
      features: async () => ({ customMonitoring: true }),
      store: {
        ...store,
        createAlertRule: (p, d, a) => store.createAlertRule(p, d, a, m.db),
      },
      observe: async () => {},
    },
  );
  assert.ok(web.ok);
  const [byMcp, byWeb] = await Promise.all([
    getAlertRule(PROJECT, alertId, m.db),
    getAlertRule(PROJECT, web.ruleId, m.db),
  ]);
  assert.deepEqual({ ...byMcp, id: "" }, { ...byWeb, id: "" });
});

test("change_alert takes RQL text that gives one number, with the rql flag only", async () => {
  const sqlAlert = (text: string) => ({
    ...ALERT,
    name: "Failed traces",
    threshold: 3,
    query: { version: 1, kind: "sql", rqlVersion: 1, text },
  });
  const off = await m.call("change_alert", {
    action: "create",
    alert: sqlAlert("select count(*) from traces"),
  });
  assert.ok(!off.ok);
  assert.match(off.message, /RQL is off/);
  m.set.rql = true;
  try {
    const many = await m.call("change_alert", {
      action: "create",
      alert: sqlAlert("select service_name, count(*) from traces group by service_name"),
    });
    assert.ok(!many.ok);
    assert.match(many.message, /gives 2 columns/);
    const { alertId, alert } = await m.data<{
      alertId: string;
      alert: { condition: string; query: object; lastError: null };
    }>("change_alert", {
      action: "create",
      alert: sqlAlert("select count(*) from traces where has_error"),
    });
    assert.equal(alert.condition, "RQL query is above 3 over 15 minutes");
    assert.deepEqual(alert.query, sqlAlert("select count(*) from traces where has_error").query);
    assert.equal(alert.lastError, null);
    const saved = await getAlertRule(PROJECT, alertId, m.db);
    assert.equal(saved?.query?.kind, "sql");
  } finally {
    m.set.rql = false;
  }
});

test("an alert is updated, paused, resumed, read with its history and deleted", async () => {
  const { destinationId } = await m.data<{ destinationId: string }>("change_alert_destination", {
    action: "add_channel",
    channelId: "C0123456789",
  });
  const { alertId } = await m.data<{ alertId: string }>("change_alert", {
    action: "create",
    alert: { ...ALERT, destinationIds: [destinationId] },
  });
  const change = (action: string, rest: object = {}) =>
    m.data<{ alert?: Record<string, unknown> }>("change_alert", { action, alertId, ...rest });
  const updated = await change("update", { alert: { threshold: 0.1 } });
  assert.equal(updated.alert?.condition, "Error rate is above 10% over 15 minutes");
  assert.deepEqual((await getAlertRule(PROJECT, alertId, m.db))?.destinationIds, [destinationId]);
  assert.equal((await change("pause")).alert?.status, "Paused");
  assert.equal((await change("resume")).alert?.status, "No data");
  await m.client.query(
    `insert into alert_events (rule_id, from_state, to_state, value, operator, threshold, window_minutes, at, notice, delivery, sent_to)
     values ($1, 'ok', 'alerting', 0.5, 'above', 0.1, 15, $2, 'fire', 'sent', $3)`,
    [alertId, NOW, JSON.stringify([destinationId])],
  );
  const read = await m.data<{ history: object[]; alert: { destinations: object[] } }>("get_alert", {
    alertId,
  });
  assert.deepEqual(read.history, [
    {
      at: NOW.toISOString(),
      from: "ok",
      to: "alerting",
      value: 0.5,
      valueText: "50%",
      condition: "Error rate is above 10% over 15 minutes",
      message: "fire",
      delivery: "sent",
      sentTo: ["#alerts"],
      error: null,
    },
  ]);
  assert.deepEqual(read.alert.destinations, [{ id: destinationId, name: "#alerts" }]);
  const list = await m.data<{ count: number; alerting: number }>("list_alerts");
  assert.deepEqual([list.count, list.alerting], [1, 0]);
  await change("delete");
  assert.deepEqual(await listAlertRules(PROJECT, m.db), []);
});

test("each refusal is an MCP error", async () => {
  const { scorerId } = await m.data<{ scorerId: string }>("change_scorer", {
    action: "create",
    scorer: CHECK,
  });
  const refusals: [string, object, string, RegExp][] = [
    ["change_scorer", { action: "create" }, "invalid_params", /Pass scorer/],
    ["change_scorer", { action: "delete" }, "invalid_params", /Pass scorerId/],
    ["change_scorer", { action: "attach", scorerId }, "invalid_params", /Pass taskId/],
    ["change_scorer", { action: "create", scorer: { name: "x" } }, "invalid_params", /settings/],
    [
      "change_scorer",
      { action: "create", scorer: { ...CHECK, config: { path: "nope", op: "eq", value: 1 } } },
      "invalid_params",
      /Choose what to read/,
    ],
    ["change_scorer", { action: "enable", scorerId: MISSING }, "not_found", /does not exist/],
    ["change_scorer", { action: "detach", scorerId, taskId: "t9" }, "not_found", /does not exist/],
    [
      "change_scorer",
      {
        action: "update",
        scorerId,
        scorer: { kind: "judge", config: { prompt: "Good?", output: "boolean" } },
      },
      "conflict",
      /keeps its kind/,
    ],
    ["test_scorer", {}, "invalid_params", /Pass scorerId or scorer/],
    ["test_scorer", { scorerId: MISSING }, "not_found", /scorer/],
    [
      "change_alert",
      {
        action: "create",
        alert: {
          ...ALERT,
          query: {
            ...ALERT.query,
            filters: { tools: ["t".repeat(1_900), "x".repeat(3_073 - 1_900 - 17)] },
          },
        },
      },
      "invalid_params",
      /The filters are too long: 3,073 bytes of JSON, 3,072 at most\./,
    ],
    ["change_alert", { action: "create" }, "invalid_params", /Pass alert/],
    ["change_alert", { action: "pause" }, "invalid_params", /Pass alertId/],
    ["change_alert", { action: "pause", alertId: MISSING }, "not_found", /no longer exists/],
    ["change_alert", { action: "update", alertId: MISSING, alert: {} }, "not_found", /alert/],
    [
      "change_alert",
      {
        action: "create",
        alert: { ...ALERT, query: { ...ALERT.query, dimensions: ["model"] } },
      },
      "invalid_params",
      /cannot be grouped/,
    ],
    ["change_alert_destination", { action: "add_channel" }, "invalid_params", /Pass channelId/],
    [
      "change_alert_destination",
      { action: "add_channel", channelId: "general" },
      "invalid_params",
      /channel ID/,
    ],
    [
      "change_alert_destination",
      { action: "add_webhook", name: "Ops", webhookUrl: "https://example.com/x" },
      "invalid_params",
      /hooks\.slack\.com/,
    ],
    [
      "change_alert_destination",
      { action: "send_test", destinationId: MISSING },
      "not_found",
      /no longer exists/,
    ],
    ["change_alert_destination", { action: "disconnect_slack" }, "forbidden", /admin/],
  ];
  for (const [id, params, error, message] of refusals) {
    const result = await m.call(id, params);
    assert.equal(!result.ok && result.error, error, `${id} ${JSON.stringify(params)}`);
    assert.match(result.ok ? "" : result.message, message);
  }
  m.set.access = { ok: false, code: "not_connected" };
  const disconnected = await m.call("change_alert_destination", {
    action: "add_channel",
    channelId: "C0123456789",
  });
  assert.equal(!disconnected.ok && disconnected.error, "conflict");
  m.set.access = { ok: true, teamId: "T1", name: "alerts" };
  const added = { action: "add_channel", channelId: "C0123456789" };
  const { destinationId } = await m.data("change_alert_destination", added);
  const twice = await m.call("change_alert_destination", added);
  assert.equal(!twice.ok && twice.error, "conflict");
  m.set.post = { ok: false, error: "The channel is archived." };
  const unsent = await m.call("change_alert_destination", { action: "send_test", destinationId });
  assert.equal(!unsent.ok && unsent.error, "conflict");
  m.deps.canSeal = () => false;
  const unsealed = await m.call("change_alert_destination", {
    action: "add_webhook",
    name: "Ops",
    webhookUrl: WEBHOOK,
  });
  m.deps.canSeal = () => true;
  assert.equal(!unsealed.ok && unsealed.error, "conflict");
});

test("Slack: the link without a connection, the channels with one, and a disconnect by an admin", async () => {
  const before = await m.call("list_slack_channels");
  assert.ok(before.ok);
  assert.match(before.hint ?? "", /\/api\/integrations\/slack\/start\?projectId=1111/);
  // F447-1: as in the console, only an admin connects Slack.
  for (const id of ["list_slack_channels", "list_alert_destinations"]) {
    const ask = { projectId: PROJECT };
    const admin = await m.call(id, ask, personAuth());
    assert.match(JSON.stringify(admin), /integrations\/slack\/start/, id);
    const asked = await m.call(id, ask, personAuth("member"));
    assert.ok(asked.ok);
    assert.doesNotMatch(JSON.stringify(asked), /integrations\/slack\/start/, id);
    assert.match(asked.hint ?? "", /Only an organization admin can connect Slack\./, id);
  }

  await connect();
  m.set.channels = {
    ok: true,
    channels: [
      { id: "C0123456789", name: "alerts", isPrivate: false },
      { id: "C0123456780", name: "random", isPrivate: false },
    ],
    partial: false,
  };
  const found = await m.data<{ channels: object[]; slack: object }>("list_slack_channels", {
    search: "#alert",
  });
  assert.deepEqual(found.channels, [{ id: "C0123456789", name: "alerts", isPrivate: false }]);
  assert.deepEqual(found.slack, {
    connected: true,
    workspace: "Acme",
    lost: false,
    appConfigured: true,
  });

  const params = { action: "disconnect_slack", projectId: PROJECT };
  const member = await m.call("change_alert_destination", params, personAuth("member"));
  assert.equal(!member.ok && member.error, "forbidden");
  assert.ok((await m.call("change_alert_destination", params, personAuth())).ok);
  const left = await m.client.query("select 1 from slack_connections");
  assert.equal(left.rows.length, 0);
});

test("F452-1: an admin changes the location attributes through MCP; a member and a key cannot", async () => {
  const change = (params: object, auth = personAuth()) =>
    m.call("change_location_attributes", { projectId: PROJECT, ...params }, auth);
  for (const auth of [personAuth("member"), KEY_AUTH]) {
    const refused = await change({ address: "app.ip" }, auth);
    assert.equal(!refused.ok && refused.error, "forbidden");
    assert.match(refused.ok ? "" : refused.message, /Only organization admins/);
  }
  assert.deepEqual(await loadGeoAttributes(PROJECT, m.db), DEFAULT_GEO_ATTRIBUTES);
  const changed = await change({ address: "app.ip" });
  assert.ok(changed.ok, JSON.stringify(changed));
  const own = { ...DEFAULT_GEO_ATTRIBUTES, address: "app.ip" };
  assert.deepEqual(await loadGeoAttributes(PROJECT, m.db), own);
  const read = await m.data<{ attributes: object; rows: { key: string; source: string }[] }>(
    "get_location_attributes",
  );
  assert.deepEqual(read.attributes, own);
  assert.deepEqual(
    read.rows.filter(({ source }) => source === "custom").map(({ key }) => key),
    ["address"],
  );
  assert.deepEqual(m.events.at(-1)?.event, "project_settings_updated");
  for (const bad of [{}, { address: "server.address" }, { latitude: " " }]) {
    const refused = await change(bad);
    assert.equal(!refused.ok && refused.error, "invalid_params", JSON.stringify(bad));
  }
  assert.ok((await change({ reset: true })).ok);
  assert.deepEqual(await loadGeoAttributes(PROJECT, m.db), DEFAULT_GEO_ATTRIBUTES);
  m.set.on = false;
  const off = await change({ address: "app.ip" });
  assert.equal(!off.ok && off.reason, "custom_monitoring_off");
});

test("no result holds a secret, and no refusal or event repeats one", async () => {
  await connect();
  const said: unknown[] = [];
  const say = async (id: string, params: object = {}) => {
    const result = await m.call(id, params);
    said.push(result);
    return result.ok ? (result.data as Record<string, string>) : {};
  };
  const { destinationId } = await say("change_alert_destination", {
    action: "add_webhook",
    name: "Ops",
    webhookUrl: WEBHOOK,
  });
  assert.ok(destinationId);
  await say("change_alert_destination", {
    action: "add_webhook",
    name: "",
    webhookUrl: WEBHOOK,
  });
  await say("change_alert_destination", {
    action: "add_webhook",
    name: "Bad",
    webhookUrl: `${WEBHOOK}?x=1`,
  });
  await say("change_alert_destination", { action: "send_test", destinationId });
  await say("change_alert", {
    action: "create",
    alert: { ...ALERT, destinationIds: [destinationId] },
  });
  for (const [id, params] of CALLS) await say(id, params);
  const [rule] = await listAlertRules(PROJECT, m.db);
  await say("get_alert", { alertId: rule.id });
  await say("change_alert_destination", { action: "delete", destinationId });

  const { rows } = await m.client.query<{ sealed: string }>(
    "select sealed_token as sealed from slack_connections",
  );
  const text = JSON.stringify([said, m.events]);
  for (const secret of [WEBHOOK, "verysecretpart", TOKEN, SECRET_KEY, rows[0].sealed])
    assert.ok(!text.includes(secret), secret.slice(0, 12));
  for (const field of ["sealedUrl", "sealedToken", "sealedSecret", "sealed_", "clientSecret"])
    assert.ok(!text.includes(field), field);
  assert.equal(m.posted.length, 1, "the test message left with the sealed destination");
});

test("a webhook URL is not recorded with the call's telemetry", async () => {
  const exporter = new InMemorySpanExporter();
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
  const params = { action: "add_webhook", name: "Ops", webhookUrl: WEBHOOK };
  assert.ok((await m.call("change_alert_destination", params)).ok);
  const recorded = exporter
    .getFinishedSpans()
    .map(({ attributes }) => String(attributes["gen_ai.tool.call.arguments"]));
  assert.equal(recorded.length, 1);
  assert.match(recorded[0], /"webhookUrl":"\[secret\]"/);
  assert.ok(
    !JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes)).includes(WEBHOOK),
  );
  trace.disable();
});

function connect() {
  return saveSlackConnection(
    {
      organizationId: ORG,
      teamId: "T1",
      teamName: "Acme",
      token: TOKEN,
      actor: "u",
      key: SECRET_KEY,
    },
    m.db,
  );
}
