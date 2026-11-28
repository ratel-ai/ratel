import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { metricQuery } from "@/lib/contracts/query";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { metricSeams, runQuery } from "@/lib/synthesis/metrics/query";
import { createPgRqlExecutor } from "@/lib/synthesis/rql/adapters/pg-executor";
import { sqlQueryRunner } from "@/lib/synthesis/rql/query";
import { createRqlGate, type RqlGate } from "@/lib/synthesis/rql/run";
import { pglitePoolOf } from "@/lib/synthesis/rql/tests/test-support";
import { formOf, sqlWidgetQuery } from "@/lib/views/dashboards/widget";
import { type AlertActionDeps, changeAlert } from "./actions";
import { deliverAlerts, MAX_ATTEMPTS } from "./deliver";
import {
  createChannelDestination,
  createDestination,
  deleteDestination,
  listDestinations,
  recordAccess,
  sealedDestination,
  sealedDestinationsOfRule,
} from "./destinations";
import { evaluationWindow } from "./domain";
import { evaluateAlerts } from "./evaluate";
import { type AlertNotifier, memoryNotifier } from "./notifier";
import { alertFormQuery } from "./parse-rule";
import { alertsRegistration, alertsStep } from "./register";
import { slackMessage } from "./slack-message";
import * as store from "./store";
import type { AlertDraft } from "./types";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const START = new Date("2026-11-24T10:00:00Z");
const DRAFT: AlertDraft = {
  name: "Too many errors",
  query: metric("error_rate", "rate"),
  operator: "above",
  threshold: 0.5,
  windowMinutes: 5,
  destinationIds: [],
};

let client: Awaited<ReturnType<typeof createMigratedPGlite>>;
let db: ReturnType<typeof getDb>;
let now: Date;
let n = 0;

before(async () => {
  client = await createMigratedPGlite();
  db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${OTHER}', '${ORG}', 'Other', 'other');
  `);
  useRql();
});
beforeEach(async () => {
  now = START;
  await client.exec("delete from alert_rules; delete from otel_trace_summaries");
});
after(() => client.close());

test("a rule fires once, stays alerting in silence, then recovers with one message", async () => {
  const id = await rule();
  const { tick, notifier, tracked } = stepper();

  await trace(false);
  await tick();
  assert.deepEqual(notifier.notices, []);

  await later(1);
  await trace(true);
  await trace(true);
  await tick();
  assert.deepEqual(
    notifier.notices.map(({ kind, ruleId, projectName, value }) => [
      kind,
      ruleId,
      projectName,
      Math.round((value ?? 0) * 100),
    ]),
    [["fire", id, "Agent", 67]],
  );
  for (let i = 0; i < 2; i++) {
    await later(1);
    await trace(true);
    await tick();
  }
  assert.equal(notifier.notices.length, 1);
  assert.equal((await store.getAlertRule(PROJECT, id, db))?.state, "alerting");

  await later(6);
  await trace(false);
  await tick();
  await later(1);
  await tick();
  assert.deepEqual(
    notifier.notices.map(({ kind }) => kind),
    ["fire", "recovery"],
  );
  assert.deepEqual(
    tracked.filter((event) => event !== "feature.alerts.delivery_failed"),
    ["feature.alerts.fired", "feature.alerts.recovered"],
  );
  const history = await store.listAlertEvents(PROJECT, id, db);
  assert.deepEqual(
    history.map((e) => [e.fromState, e.toState, e.notice, e.delivery]),
    [
      ["alerting", "ok", "recovery", "sent"],
      ["ok", "alerting", "fire", "sent"],
      ["no_data", "ok", null, "none"],
    ],
  );
  assert.deepEqual(await store.listAlertEvents(OTHER, id, db), []);
});

test("F446-1: a trace longer than the window fires once, when its summary is known", async () => {
  await rule({ query: metric("latency", "p95"), threshold: 1000, windowMinutes: 5 });
  const { tick, notifier } = stepper();
  for (let minute = 0; minute <= 12; minute++) {
    // It started at minute 0 and ended at minute 6, as its summary was written.
    if (minute === 6)
      await client.query(
        `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
           input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at)
         values ($1, 'long', $2, 360000, true, 1, 1, 0, $3, $3)`,
        [PROJECT, START, now],
      );
    await tick();
    await later(1);
  }
  assert.deepEqual(
    notifier.notices.map(({ kind, value }) => [kind, value]),
    [["fire", 360_000]],
  );
});

test("F446-1: a result counts when it was stored, and a dashboard reads by the trace's start", async () => {
  const { rows } = await client.query<{ id: string }>(
    `insert into trace_scorers (project_id, name, kind, config, created_by, updated_by)
     values ($1, 'Fast', 'check', '{"path":"duration_ms","op":"exists"}', 'u', 'u') returning id`,
    [PROJECT],
  );
  const id = await rule({
    query: metric("scorer_count", "count"),
    operator: "above",
    threshold: 0,
  });
  const started = new Date(now.getTime() - 3_600_000);
  await client.query(
    `insert into trace_scores (scorer_id, trace_id, project_id, value, passed, trace_started_at, scored_at)
     values ($1, 'late', $2, 1, true, $3, $4)`,
    [rows[0]?.id, PROJECT, started, new Date(now.getTime() - 1000)],
  );
  await evaluate();
  assert.equal((await store.getAlertRule(PROJECT, id, db))?.state, "alerting");
  // The dashboard reads the metric by the trace's start.
  const query = metricQuery("scorer_count", "count");
  const read = (since: Date) => runQuery(PROJECT, query, { since, until: now }, db);
  assert.equal((await read(new Date(now.getTime() - 300_000))).series[0]?.total, 0);
  assert.equal((await read(started)).series[0]?.total, 1);
});

test("F446-2: a count or a sum of nothing is 0; an average of nothing is no data", async () => {
  const below = { operator: "below", threshold: 10 } as const;
  const count = await rule({ query: metric("trace_count", "count"), ...below });
  const sum = await rule({ query: metric("cost", "sum"), ...below });
  const average = await rule({ query: metric("cost", "avg"), ...below });
  const p95 = await rule({ query: metric("latency", "p95"), ...below });
  const { tick, notifier } = stepper();
  await tick();
  const states = await Promise.all(
    [count, sum, average, p95].map(async (id) => {
      const found = await store.getAlertRule(PROJECT, id, db);
      return [found?.state, found?.lastValue];
    }),
  );
  assert.deepEqual(states, [
    ["alerting", 0],
    ["alerting", 0],
    ["no_data", null],
    ["no_data", null],
  ]);
  assert.deepEqual(notifier.notices.map(({ ruleId }) => ruleId).sort(), [count, sum].sort());
});

test("an old metric rule loads as RQL with its form, evaluates to the metric's value, and saves in the new shape", async () => {
  const id = await rule();
  const old = metricQuery("error_rate", "rate");
  await client.query("update alert_rules set query = $1::jsonb where id = $2", [old, id]);
  const loaded = await store.getAlertRule(PROJECT, id, db);
  assert.deepEqual(loaded?.query, metric("error_rate", "rate"));
  await trace(true);
  await trace(false);
  await evaluate();
  // The value the metric form gives over the rule's window, by known time.
  const expected = await runQuery(PROJECT, old, evaluationWindow(5, now), db);
  assert.equal((await store.getAlertRule(PROJECT, id, db))?.lastValue, expected.series[0].total);
  assert.equal(expected.series[0].total, 0.5);
  const saved = await change({
    action: "update",
    ruleId: id,
    draft: { ...DRAFT, query: old, threshold: 0.4 },
  });
  assert.ok(saved.ok, JSON.stringify(saved));
  const { rows } = await client.query<{ query: { kind: string; form?: unknown } }>(
    "select query from alert_rules where id = $1",
    [id],
  );
  assert.equal(rows[0]?.query.kind, "sql");
  assert.deepEqual(rows[0]?.query.form, formOf(old));
});

test("every rule reads on the alert path: the alert gate, never the interactive one", async () => {
  await rule();
  await trace(true);
  const entered: string[] = [];
  const spy = (name: string, gate = createRqlGate(1)): RqlGate => ({
    enter: (project) => (entered.push(name), gate.enter(project)),
    wait: (project, ms) => (entered.push(name), gate.wait(project, ms)),
  });
  metricSeams.sql = sqlQueryRunner({
    run: {
      executor: createPgRqlExecutor(pglitePoolOf(client)),
      gate: spy("interactive"),
      observe: async () => {},
    },
    alertGate: spy("alert"),
  });
  try {
    assert.equal((await evaluate()).evaluated, 1);
    assert.deepEqual(entered, ["alert"]);
  } finally {
    useRql();
  }
});

test("a rule is not evaluated twice in one tick, nor while it is paused", async () => {
  const id = await rule();
  await trace(true);
  assert.equal((await evaluate()).evaluated, 1);
  assert.equal((await evaluate()).evaluated, 0);
  await later(1);
  assert.equal((await evaluate()).evaluated, 1);
  await store.setAlertRuleEnabled(PROJECT, id, false, "u", db);
  await later(60);
  assert.equal((await evaluate()).evaluated, 0);
  assert.equal((await store.getAlertRule(PROJECT, id, db))?.state, "alerting");
});

test("a rule whose stored query is malformed needs attention, is skipped with one event, and stops no other rule", async () => {
  const broken = await rule();
  const shapes = ["null", '{"metric":"error_rate","aggregation":"rate"}', "[]"];
  const fine = await rule();
  await trace(true);
  const step = stepper();
  for (const shape of shapes) {
    await client.query("update alert_rules set query = $1::jsonb where id = $2", [shape, broken]);
    const listed = await store.listAlertRules(PROJECT, db);
    const shown = listed.find(({ id }) => id === broken);
    assert.equal(shown?.query, null, shape);
    assert.match(shown?.problem ?? "", /Unknown query kind/);
    assert.equal((await store.getAlertRule(PROJECT, broken, db))?.problem, shown?.problem);
    assert.equal(listed.find(({ id }) => id === fine)?.problem, null);
    await step.tick();
    await later(1);
  }
  const states = await store.listAlertRules(PROJECT, db);
  assert.deepEqual(
    [broken, fine].map((id) => states.find((r) => r.id === id)?.state),
    ["no_data", "alerting"],
  );
  assert.deepEqual(await store.listAlertEvents(PROJECT, broken, db), []);
  assert.deepEqual(
    step.tracked.filter((event) => event === "feature.alerts.skipped"),
    ["feature.alerts.skipped"],
    "one event, whatever the number of ticks",
  );
  const result = await evaluate();
  assert.deepEqual([result.failed, result.skipped.map(({ ruleId }) => ruleId)], [0, [broken]]);

  // A message that waited when the rule broke is still sent, and reads.
  await client.query("update alert_rules set query = 'null' where id = $1", [fine]);
  await client.exec("update alert_events set delivery = 'pending' where notice is not null");
  const notifier = memoryNotifier();
  await deliverAlerts(notifier, { now: () => now }, db);
  assert.match(slackMessage(notifier.notices[0], "https://x").text, /The value is above 0.5/);
});

test("a scorer metric fires on that scorer's results", async () => {
  const scorer = "44444444-4444-4444-8444-444444444444";
  await client.exec(`
    insert into trace_scorers (id, project_id, name, kind, config, created_by, updated_by)
    values ('${scorer}', '${PROJECT}', 'Polite', 'check', '{}', 'u', 'u')`);
  await client.query(
    `insert into trace_scores (scorer_id, trace_id, project_id, value, passed, trace_started_at, scored_at)
     values ($1, 'a', $2, 0, false, $3, $3)`,
    [scorer, PROJECT, new Date(now.getTime() - 1000)],
  );
  const id = await rule({
    query: metric("scorer_pass_rate", "rate", { filters: { scorer: { id: scorer } } }),
    operator: "below",
  });
  const result = await evaluateAlerts({ now: () => now }, db);
  assert.deepEqual(
    result.changes.map(({ ruleId, notice }) => [ruleId, notice]),
    [[id, "fire"]],
  );
});

test("a failed message is tried again, 3 times at most, and never in two ticks at once", async () => {
  const id = await rule();
  await trace(true);
  await evaluate();
  const notifier = memoryNotifier();
  const on = { now: () => now };
  notifier.fail = MAX_ATTEMPTS;
  for (let i = 1; i < MAX_ATTEMPTS; i++)
    assert.equal((await deliverAlerts(notifier, on, db)).retrying, 1);
  assert.equal((await deliverAlerts(notifier, on, db)).failures.length, 1);
  assert.deepEqual(await deliverAlerts(notifier, on, db), {
    sent: 0,
    retrying: 0,
    expired: 0,
    failures: [],
  });
  const [event] = await store.listAlertEvents(PROJECT, id, db);
  assert.deepEqual([event.delivery, event.attempts, event.error], ["failed", 4, "unreachable"]);

  await client.exec("update alert_events set delivery = 'pending', attempts = 0");
  const inside: unknown[] = [];
  const nested: AlertNotifier = {
    send: async () => {
      inside.push(await deliverAlerts(notifier, on, db));
      throw new Error("https://hooks.slack.com/services/secret");
    },
  };
  assert.equal((await deliverAlerts(nested, on, db)).retrying, 1);
  assert.deepEqual(inside, [{ sent: 0, retrying: 0, expired: 0, failures: [] }]);
  assert.doesNotMatch(
    (await store.listAlertEvents(PROJECT, id, db))[0].error ?? "",
    /hooks\.slack/,
  );
});

test("F446-3: a message still pending after a day expires, with a log", async () => {
  const id = await rule();
  await pending(id, 1, new Date(now.getTime() - 25 * 3_600_000));
  const notifier = memoryNotifier();
  const result = await deliverAlerts(notifier, { now: () => now }, db);
  assert.equal(result.expired, 1);
  const [event] = await store.listAlertEvents(PROJECT, id, db);
  assert.deepEqual([event.delivery, event.error], ["failed", "The message expired unsent."]);
  assert.deepEqual(notifier.notices, []);
});

test("F446-5: the history keeps 90 days, pruned in bounded batches on the tick", async () => {
  const id = await rule();
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
  await pending(id, 3, days(91));
  await client.query("update alert_events set delivery = 'sent'");
  await pending(id, 1, days(91));
  await pending(id, 1, days(89));
  const prune = () => store.pruneAlertEvents({ now: () => now, limit: 2 }, db);
  assert.deepEqual([await prune(), await prune(), await prune()], [2, 1, 0]);
  const { rows } = await client.query<{ delivery: string; old: boolean }>(
    "select delivery, at < $1 as old from alert_events order by at",
    [days(90)],
  );
  assert.deepEqual(rows, [
    { delivery: "pending", old: true },
    { delivery: "pending", old: false },
  ]);
  const step = alertsRegistration.drainSteps?.find(({ name }) => name === "alert_events_prune");
  assert.deepEqual([step?.phase, step?.retentionOnly], ["after", undefined]);
  assert.equal(store.ALERT_HISTORY_DAYS, 90);
});

test("a rule keeps its project's destinations only; a removed one leaves the rule", async () => {
  const input = {
    name: "Ops",
    url: new URL("https://hooks.slack.com/services/T/B/wxyz"),
    actor: "u",
    key: "k",
  };
  const mine = await createDestination({ ...input, projectId: PROJECT }, db);
  const foreign = await createDestination({ ...input, projectId: OTHER }, db);
  const id = await rule({ destinationIds: [mine, foreign] });
  const ids = async () => (await store.getAlertRule(PROJECT, id, db))?.destinationIds;
  assert.deepEqual(await ids(), [mine]);
  assert.deepEqual(await listDestinations(PROJECT, db), [
    { id: mine, name: "Ops", kind: "webhook", lastFour: "wxyz" },
  ]);
  const stored = await client.query("select * from alert_destinations");
  assert.doesNotMatch(JSON.stringify(stored.rows), /hooks\.slack/);
  assert.equal(await deleteDestination(OTHER, mine, db), false);
  assert.equal(await deleteDestination(PROJECT, mine, db), true);
  assert.deepEqual(await ids(), []);
});

test("a channel destination is one per project, and keeps its last access", async () => {
  const input = {
    projectId: PROJECT,
    name: "#ops",
    teamId: "T1",
    channelId: "C0000001",
    accessError: "not_in_channel",
    actor: "u",
  };
  const id = await createChannelDestination(input, db);
  assert.ok(id);
  assert.equal(await createChannelDestination(input, db), "taken");
  const other = await createChannelDestination({ ...input, projectId: OTHER }, db);
  assert.ok(other);
  await recordAccess(id, null, db);
  const channel = {
    id,
    name: "#ops",
    kind: "slack_channel",
    teamId: "T1",
    channelId: "C0000001",
    accessError: null,
  };
  assert.deepEqual(await sealedDestination(PROJECT, id, db), { ...channel, organizationId: ORG });
  const ruleId = await rule({ destinationIds: [id] });
  assert.deepEqual(await sealedDestinationsOfRule(ruleId, db), [
    { ...channel, organizationId: ORG },
  ]);
  await deleteDestination(PROJECT, id, db);
  await deleteDestination(OTHER, other, db);
});

test("an RQL rule fires over its threshold, resolves under it, and fails without firing on a refusal", async () => {
  useRql();
  const id = await rule({
    name: "Failed traces",
    query: sqlWidgetQuery("select count(*) as failed from traces where has_error"),
    threshold: 1,
  });
  const { tick, notifier } = stepper();

  await trace(true);
  await trace(true);
  await trace(false);
  await tick();
  assert.deepEqual(
    notifier.notices.map(({ kind, ruleId, value }) => [kind, ruleId, value]),
    [["fire", id, 2]],
  );

  // The window moves past the failed traces.
  await later(10);
  await trace(false);
  await tick();
  assert.deepEqual(
    notifier.notices.map(({ kind, value }) => [kind, value]),
    [
      ["fire", 2],
      ["recovery", 0],
    ],
  );

  // A query RQL refuses at run time marks the rule as failing: no state change, no message.
  await client.query("update alert_rules set query = $2 where id = $1", [
    id,
    sqlWidgetQuery("select count(*) from spans"),
  ]);
  await later(10);
  await trace(true);
  await trace(true);
  const failing = await evaluate();
  assert.equal(failing.failed, 1);
  const stored = await store.getAlertRule(PROJECT, id, db);
  assert.equal(stored?.state, "ok");
  assert.match(stored?.lastError ?? "", /spans.*Fix: /);
  await tick();
  assert.equal(notifier.notices.length, 2);

  // Fixed, it reads again and the error goes.
  await client.query("update alert_rules set query = $2 where id = $1", [
    id,
    sqlWidgetQuery("select count(*) from traces where has_error"),
  ]);
  await later(10);
  await trace(true);
  await trace(true);
  await tick();
  const fixed = await store.getAlertRule(PROJECT, id, db);
  assert.deepEqual([fixed?.state, fixed?.lastError, fixed?.lastValue], ["alerting", null, 2]);
});

test("an RQL rule must give one row with one number: anything else is refused at save", async () => {
  const draft = (text: string) => ({ ...DRAFT, query: sqlWidgetQuery(text) });
  const refusals: [string, RegExp][] = [
    ["select count(*), avg(duration_ms) from traces", /gives 2 columns/],
    ["select count(*) from traces group by service_name", /can give many rows/],
    ["select duration_ms from traces", /can give many rows/],
    ["select max(service_name) from traces", /is text/],
    ["select count(*) from spans", /spans.*Fix: /],
  ];
  for (const [text, error] of refusals) {
    const result = await change({ action: "create", draft: draft(text) });
    assert.ok(!result.ok, text);
    assert.match(result.error, error, text);
  }
  const created = await change({ action: "create", draft: draft("select count(*) from traces") });
  assert.ok(created.ok, JSON.stringify(created));
  const saved = await store.getAlertRule(PROJECT, created.ruleId, db);
  assert.deepEqual(saved?.query, sqlWidgetQuery("select count(*) from traces"));
});

test("a person creates, edits, pauses and deletes a rule; others cannot", async () => {
  const created = await change({ action: "create", draft: DRAFT });
  assert.ok(created.ok);
  const { ruleId } = created;
  assert.ok((await change({ action: "update", ruleId, draft: { ...DRAFT, threshold: 0.9 } })).ok);
  assert.ok((await change({ action: "set_enabled", ruleId, enabled: false })).ok);
  const grouped = metricQuery("error_rate", "rate", { dimensions: ["model"] });
  assert.ok(!(await change({ action: "create", draft: { ...DRAFT, query: grouped } })).ok);
  const saved = await store.getAlertRule(PROJECT, ruleId, db);
  assert.deepEqual([saved?.threshold, saved?.enabled, saved?.query], [0.9, false, DRAFT.query]);
  assert.equal(
    (await change({ action: "delete", ruleId }, { findProjectScope: async () => null })).ok,
    false,
  );
  assert.equal(
    (await change({ action: "delete", ruleId }, { isRestricted: async () => true })).ok,
    false,
  );
  assert.equal(
    (await change({ action: "update", ruleId, draft: { ...DRAFT, name: "" } })).ok,
    false,
  );
  assert.ok((await change({ action: "delete", ruleId })).ok);
  assert.equal((await change({ action: "delete", ruleId })).ok, false);
});

/** `count` fire messages of a rule, waiting since `at`. */
async function pending(ruleId: string, count: number, at: Date) {
  await client.query(
    `insert into alert_events (rule_id, from_state, to_state, value, operator, threshold,
       window_minutes, at, notice, delivery)
     select $1, 'ok', 'alerting', 1, 'above', 0.5, 5, $2::timestamptz + make_interval(secs => g / 1000.0), 'fire', 'pending'
     from generate_series(1, $3) g`,
    [ruleId, at, count],
  );
}

async function rule(over: Partial<Parameters<typeof store.createAlertRule>[1]> = {}) {
  const id = await store.createAlertRule(PROJECT, { ...DRAFT, ...over }, "u", db);
  assert.ok(id);
  return id;
}

async function trace(failed: boolean) {
  await client.query(
    `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
       input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at)
     values ($1, $2, $3, 500, $4, 1, 1, 0, $3, $3)`,
    [PROJECT, `t${n++}`, new Date(now.getTime() - 1000), failed],
  );
}

async function later(minutes: number) {
  now = new Date(now.getTime() + minutes * 60_000);
}

function evaluate() {
  return evaluateAlerts({ now: () => now }, db);
}

/** Kind sql through the RQL runner on this database: every rule reads there, on the alert path. */
function useRql() {
  metricSeams.sql = sqlQueryRunner({
    run: {
      executor: createPgRqlExecutor(pglitePoolOf(client)),
      gate: createRqlGate(),
      observe: async () => {},
    },
    alertGate: createRqlGate(1),
  });
}

/** An ungrouped metric as a rule keeps it: RQL with the metric as its form. */
function metric(...args: Parameters<typeof metricQuery>) {
  return alertFormQuery(formOf(metricQuery(...args)));
}

function stepper() {
  const notifier = memoryNotifier();
  const tracked: string[] = [];
  const step = alertsStep({
    evaluate,
    deliver: () => deliverAlerts(notifier, { now: () => now }, db),
    track: async (event) => {
      tracked.push(event);
    },
  });
  return { tick: () => step.run(), notifier, tracked };
}

function change(input: Record<string, unknown>, over: Partial<AlertActionDeps> = {}) {
  const bound = {
    createAlertRule: (p, d, a) => store.createAlertRule(p, d, a, db),
    updateAlertRule: (p, i, d, a) => store.updateAlertRule(p, i, d, a, db),
    setAlertRuleEnabled: (p, i, e, a) => store.setAlertRuleEnabled(p, i, e, a, db),
    deleteAlertRule: (p, i) => store.deleteAlertRule(p, i, db),
  } as AlertActionDeps["store"];
  return changeAlert(
    { projectId: PROJECT, ...input },
    {
      getSession: async () => ({ user: { id: "u", externalId: "ext" } }),
      findProjectScope: async (id) => ({ project: { id }, organization: { id: ORG } }),
      isRestricted: async () => false,
      store: bound,
      observe: async () => {},
      ...over,
    },
  );
}
