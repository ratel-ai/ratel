import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { type AlertActionDeps, changeAlert } from "./actions";
import { deliverAlerts, MAX_ATTEMPTS } from "./deliver";
import { evaluateAlerts } from "./evaluate";
import { type AlertNotifier, memoryNotifier } from "./notifier";
import { alertsStep } from "./register";
import * as store from "./store";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const START = new Date("2026-11-24T10:00:00Z");
const DRAFT = {
  name: "Too many errors",
  query: { metric: "error_rate", aggregation: "rate", filter: {} },
  operator: "above",
  threshold: 0.5,
  windowMinutes: 5,
} as const;

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

test("a metric that left the catalog, or is off, is no data and stops no other rule", async () => {
  const gone = await rule();
  await client.query(`update alert_rules set query = '{"metric":"gone","aggregation":"rate"}'`);
  const off = await rule({
    query: { metric: "scorer_pass_rate", aggregation: "rate", filter: {} },
  });
  const fine = await rule();
  await trace(true);
  const result = await evaluate();
  assert.deepEqual([result.evaluated, result.failed], [3, 0]);
  const states = await store.listAlertRules(PROJECT, db);
  assert.deepEqual(
    [gone, off, fine].map((id) => states.find((r) => r.id === id)?.state),
    ["no_data", "no_data", "alerting"],
  );
});

test("a scorer metric fires on that scorer's results", async () => {
  const scorer = "44444444-4444-4444-8444-444444444444";
  await client.exec(`
    insert into trace_scorers (id, project_id, name, kind, config, created_by, updated_by)
    values ('${scorer}', '${PROJECT}', 'Polite', 'check', '{}', 'u', 'u')`);
  await client.query(
    `insert into trace_scores (scorer_id, trace_id, project_id, value, passed, trace_started_at)
     values ($1, 'a', $2, 0, false, $3)`,
    [scorer, PROJECT, new Date(now.getTime() - 1000)],
  );
  const id = await rule({
    query: {
      metric: "scorer_pass_rate",
      aggregation: "rate",
      filter: {},
      scorerId: scorer,
    },
    operator: "below",
  });
  const result = await evaluateAlerts(
    { now: () => now, flagOn: async () => true, scorersOn: async () => true },
    db,
  );
  assert.deepEqual(
    result.changes.map(({ ruleId, notice }) => [ruleId, notice]),
    [[id, "fire"]],
  );
});

test("with the flag off, nothing is read, changed or sent", async () => {
  const id = await rule();
  await trace(true);
  const off = { now: () => now, flagOn: async () => false };
  assert.deepEqual(await evaluateAlerts(off, db), {
    evaluated: 0,
    failed: 0,
    changes: [],
    lockContended: false,
  });
  assert.equal((await store.getAlertRule(PROJECT, id, db))?.state, "no_data");
  await evaluate();
  const notifier = memoryNotifier();
  assert.equal((await deliverAlerts(notifier, off, db)).sent, 0);
  assert.deepEqual(notifier.notices, []);
});

test("a failed message is tried again, 3 times at most, and never in two ticks at once", async () => {
  const id = await rule();
  await trace(true);
  await evaluate();
  const notifier = memoryNotifier();
  const on = { now: () => now, flagOn: async () => true };
  notifier.fail = MAX_ATTEMPTS;
  for (let i = 1; i < MAX_ATTEMPTS; i++)
    assert.equal((await deliverAlerts(notifier, on, db)).retrying, 1);
  assert.equal((await deliverAlerts(notifier, on, db)).failures.length, 1);
  assert.deepEqual(await deliverAlerts(notifier, on, db), { sent: 0, retrying: 0, failures: [] });
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
  assert.deepEqual(inside, [{ sent: 0, retrying: 0, failures: [] }]);
  assert.doesNotMatch(
    (await store.listAlertEvents(PROJECT, id, db))[0].error ?? "",
    /hooks\.slack/,
  );
});

test("a person creates, edits, pauses and deletes a rule; others cannot", async () => {
  const created = await change({ action: "create", draft: DRAFT });
  assert.ok(created.ok);
  const { ruleId } = created;
  assert.ok((await change({ action: "update", ruleId, draft: { ...DRAFT, threshold: 0.9 } })).ok);
  assert.ok((await change({ action: "set_enabled", ruleId, enabled: false })).ok);
  const saved = await store.getAlertRule(PROJECT, ruleId, db);
  assert.deepEqual([saved?.threshold, saved?.enabled], [0.9, false]);
  assert.equal(
    (await change({ action: "create", draft: DRAFT }, { enabled: async () => false })).ok,
    false,
  );
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

async function rule(over: Partial<Parameters<typeof store.createAlertRule>[1]> = {}) {
  return store.createAlertRule(PROJECT, { ...DRAFT, ...over }, "u", db);
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
  return evaluateAlerts(
    { now: () => now, flagOn: async () => true, scorersOn: async () => false },
    db,
  );
}

function stepper() {
  const notifier = memoryNotifier();
  const tracked: string[] = [];
  const step = alertsStep({
    evaluate,
    deliver: () => deliverAlerts(notifier, { now: () => now, flagOn: async () => true }, db),
    track: async (event) => {
      tracked.push(event);
    },
  });
  return { tick: () => step.run(), notifier, tracked };
}

function change(input: Record<string, unknown>, over: Partial<AlertActionDeps> = {}) {
  const bound = {
    countAlertRules: (p: string) => store.countAlertRules(p, db),
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
      enabled: async () => true,
      isRestricted: async () => false,
      features: async () => ({ scorers: false }),
      store: bound,
      observe: async () => {},
      ...over,
    },
  );
}
