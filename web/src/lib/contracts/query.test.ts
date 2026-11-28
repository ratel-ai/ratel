import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { MAX_FILTER_BYTES } from "./filter-budget";
import {
  AGGREGATIONS,
  DIMENSIONS,
  flowQuery,
  geographyQuery,
  MAX_SQL_TEXT,
  MEASURE_IDS,
  MEASURES,
  parseQuery,
  portableQuerySchema,
  queryProperties,
  stepFlowQuery,
} from "./query";

const SCORER = "44444444-4444-4444-8444-444444444444";
const BASE = {
  version: 1,
  kind: "metric",
  measures: [{ measure: "latency", aggregation: "p95" }],
};

test("each measure takes exactly its aggregations and dimensions", () => {
  for (const measure of MEASURE_IDS) {
    const rules = MEASURES[measure];
    const query = (aggregation: string, dimensions: string[] = []) =>
      parseQuery({ ...BASE, measures: [{ measure, aggregation }], dimensions }).ok;
    for (const aggregation of AGGREGATIONS)
      assert.equal(
        query(aggregation),
        (rules.aggregations as readonly string[]).includes(aggregation),
        `${measure} ${aggregation}`,
      );
    for (const dimension of DIMENSIONS)
      assert.equal(
        query(rules.aggregations[0], [dimension]),
        (rules.dimensions as readonly string[]).includes(dimension),
        `${measure} by ${dimension}`,
      );
  }
});

test("a step flow has its defaults, and refuses what it cannot read", () => {
  const given = { version: 1, kind: "step_flow", node: "mcp_server" };
  assert.deepEqual(parseQuery(given), { ok: true, query: stepFlowQuery("mcp_server") });
  assert.ok(parseQuery({ ...given, mode: "before", target: "crm", steps: 6 }).ok);
  const refused: [object, RegExp][] = [
    [{ node: "scorer" }, /no steps of "scorer".*tool, skill, agent, mcp_server, model/],
    [{ steps: 7 }, /A step flow has 1 to 6 steps/],
    [{ steps: 0 }, /A step flow has 1 to 6 steps/],
    [{ nodes: 21 }, /A step flow has 1 to 20 nodes per column/],
    [{ mode: "before" }, /Choose the node to look before/],
    [{ mode: "before", target: " " }, /invalid at "target"/],
    [{ target: "crm" }, /Only mode "before" has a target/],
    [{ start: "user" }, /invalid at "start"/],
    [{ edges: 4 }, /invalid/],
  ];
  for (const [change, says] of refused) {
    const parsed = parseQuery({ ...given, ...change });
    assert.ok(!parsed.ok && says.test(parsed.error), JSON.stringify([change, parsed]));
  }
});

test("dimensions and filters default to none", () => {
  assert.deepEqual(parseQuery(BASE), { ok: true, query: { ...BASE, dimensions: [], filters: {} } });
});

test("a filter is a list of clauses; the form of one clause is as it was", () => {
  const filtersOf = (filters: object) => {
    const parsed = parseQuery({ ...BASE, filters });
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    return "filters" in parsed.query ? parsed.query.filters : null;
  };
  const one = { environments: ["production"], status: "failed" };
  assert.deepEqual(filtersOf(one), one);
  const list = { ...one, and: [{ environments: ["staging"] }, { tools: ["a"] }] };
  assert.deepEqual(filtersOf(list), list);
  const published = z.fromJSONSchema(z.toJSONSchema(portableQuerySchema, { io: "input" }) as never);
  assert.ok(published.safeParse({ ...BASE, filters: list }).success);

  const refused = (filters: object, of: object = BASE) => {
    const parsed = parseQuery({ ...of, filters });
    assert.ok(!parsed.ok);
    return parsed.error;
  };
  assert.match(refused({ and: [{ and: [] }] }), /filters\.and\.0/);
  // All clauses have one budget, and no part of it has another.
  const many = { and: Array.from({ length: 40 }, (_, i) => ({ tools: [`${i}`] })) };
  assert.deepEqual(filtersOf(many), many);
  const sized = (bytes: number) => {
    const filter = (text: string) => ({
      tools: ["a"],
      and: [{ agents: ["x".repeat(1_500)] }, { tools: [text] }],
    });
    return filter("y".repeat(bytes - JSON.stringify(filter("")).length));
  };
  assert.deepEqual(filtersOf(sized(MAX_FILTER_BYTES)), sized(MAX_FILTER_BYTES));
  const message = "The filters are too long: 3,073 bytes of JSON, 3,072 at most.";
  assert.equal(refused(sized(MAX_FILTER_BYTES + 1)), message);
  const flow = { version: 1, kind: "flow", node: "tool" };
  assert.equal(refused(sized(MAX_FILTER_BYTES + 1), flow), message);
  const context = { ...BASE, measures: [{ measure: "context_cost", aggregation: "sum" }] };
  assert.ok(refused({ and: [one] }, context));
});

test("what the contract does not allow is refused in words", () => {
  const context = { measures: [{ measure: "context_cost", aggregation: "sum" }] };
  const refused: [unknown, RegExp][] = [
    [null, /Unknown query kind/],
    [
      { ...BASE, kind: "pie" },
      /Unknown query kind "pie"\. The kinds are: metric, flow, step_flow, funnel, clusters, geography, sql\./,
    ],
    [{ ...BASE, version: 2 }, /Unknown query version "2"\. The version is 1\./],
    [{ ...BASE, version: undefined }, /Unknown query version/],
    [{ ...BASE, measures: [{ measure: "nope", aggregation: "sum" }] }, /Unknown measure "nope"/],
    [{ ...BASE, measures: [{ measure: "toString", aggregation: "sum" }] }, /Unknown measure/],
    [
      { ...BASE, measures: [{ measure: "latency", aggregation: "sum" }] },
      /Latency cannot be aggregated by "sum"/,
    ],
    [{ ...BASE, measures: [] }, /invalid at "measures"/],
    [{ ...BASE, measures: [BASE.measures[0], BASE.measures[0]] }, /invalid at "measures"/],
    [{ ...BASE, dimensions: ["customer"] }, /Unknown dimension "customer"/],
    [{ ...BASE, dimensions: ["model", "model"] }, /twice/],
    [{ ...BASE, dimensions: ["model", "tool", "agent"] }, /2 dimensions at most/],
    [{ ...BASE, filters: { sql: "1=1" } }, /invalid at "filters"/],
    [{ ...BASE, filters: { models: "gpt-4o" } }, /invalid at "filters.models"/],
    [{ ...BASE, filters: { scorer: { id: SCORER } } }, /cannot be filtered by scorer/],
    [{ ...BASE, window: {} }, /invalid/],
    [{ ...BASE, ...context, dimensions: ["model"] }, /be grouped/],
    [{ ...BASE, ...context, filters: { models: ["a"] } }, /cannot be filtered/],
    [{ ...BASE, ...context, bucket: "hour" }, /no hour buckets/],
  ];
  for (const [raw, error] of refused) {
    const parsed = parseQuery(raw);
    assert.ok(!parsed.ok, JSON.stringify(raw));
    assert.match(parsed.error, error);
  }
});

test("a scorer is its id inside a project and its name between projects", () => {
  const query = (scorer: object) => ({
    ...BASE,
    measures: [{ measure: "scorer_pass_rate", aggregation: "rate" }],
    filters: { scorer },
  });
  assert.ok(parseQuery(query({ id: SCORER })).ok);
  assert.deepEqual(parseQuery(query({ id: "nope" })), { ok: false, error: "Unknown scorer." });
  assert.ok(!parseQuery(query({ name: "Polite" })).ok);
  assert.ok(portableQuerySchema.safeParse(query({ name: "Polite" })).success);
  assert.ok(!portableQuerySchema.safeParse(query({ id: SCORER })).success);
});

test("a flow has its defaults, and each limit is refused in words", () => {
  const flow = { version: 1, kind: "flow", node: "tool" };
  assert.deepEqual(parseQuery(flow), {
    ok: true,
    query: { ...flow, steps: 5, edges: 50, filters: {} },
  });
  const refused: [object, RegExp][] = [
    [{ node: "model" }, /cannot move between "model"/],
    [{ steps: 1 }, /2 to 8 steps/],
    [{ steps: 9 }, /2 to 8 steps/],
    [{ edges: 201 }, /1 to 200 edges/],
    [{ start: "" }, /invalid at "start"/],
    [{ filters: { scorer: { id: SCORER } } }, /invalid/],
    [{ measures: [] }, /invalid/],
  ];
  for (const [change, error] of refused) {
    const parsed = parseQuery({ ...flow, ...change });
    assert.ok(!parsed.ok, JSON.stringify(change));
    assert.match(parsed.error, error);
  }
});

test("a funnel has 2 to 8 steps, each with a condition the contract knows", () => {
  const step = { name: "ok", condition: { type: "no_error" } };
  const funnel = { version: 1, kind: "funnel", steps: [step, step] };
  assert.deepEqual(parseQuery(funnel), {
    ok: true,
    query: { ...funnel, order: "in_order", filters: {} },
  });
  const steps = (condition: object) => ({ steps: [step, { name: "x", condition }] });
  const check = { type: "attribute", path: "duration_ms", op: "lt", value: "900" };
  const scorer = { type: "scorer", scorer: { id: SCORER } };
  for (const condition of [
    { type: "tool", name: "a" },
    { type: "skill", name: "a" },
    check,
    { type: "attribute", path: "attributes.user.plan", op: "exists" },
    { ...scorer, result: "failed" },
    { ...scorer, atLeast: 4 },
  ])
    assert.ok(parseQuery({ ...funnel, ...steps(condition) }).ok, JSON.stringify(condition));
  const refused: [object, RegExp][] = [
    [{ steps: [step] }, /2 to 8 steps/],
    [{ steps: Array(9).fill(step) }, /2 to 8 steps/],
    [{ steps: [step, { ...step, name: " " }] }, /Name each step/],
    [{ order: "some" }, /invalid at "order"/],
    [steps({ type: "tool", name: "" }), /Name the tool/],
    [steps({ type: "vibe" }), /A step takes a tool/],
    [steps({ ...check, path: "nope" }), /Choose what to read/],
    [steps({ ...check, value: "fast" }), /compares with a number/],
    [steps({ ...check, value: undefined }), /a value to compare with/],
    [steps({ ...check, op: "exists" }), /compares with nothing/],
    [steps(scorer), /a result or a least score/],
    [steps({ ...scorer, result: "passed", atLeast: 2 }), /a result or a least score/],
    [steps({ ...scorer, scorer: { id: "x" }, result: "passed" }), /Unknown scorer/],
  ];
  for (const [change, error] of refused) {
    const parsed = parseQuery({ ...funnel, ...change });
    assert.ok(!parsed.ok, JSON.stringify(change));
    assert.match(parsed.error, error);
  }
});

test("a clusters query picks a part of the map by name and size, and takes no trace filter", () => {
  const clusters = { version: 1, kind: "clusters", view: "asks" };
  assert.deepEqual(parseQuery(clusters), { ok: true, query: clusters });
  assert.ok(parseQuery({ ...clusters, tools: ["a"], minSize: 3 }).ok);
  for (const change of [{ view: "map" }, { filters: {} }, { minSize: -1 }, { tasks: [""] }])
    assert.ok(!parseQuery({ ...clusters, ...change }).ok, JSON.stringify(change));
});

test("a map shows one measure of traces, of the world or of one country", () => {
  const map = {
    version: 1,
    kind: "geography",
    measures: [{ measure: "trace_count", aggregation: "count" }],
  };
  assert.deepEqual(parseQuery(map), { ok: true, query: { ...map, level: "world", filters: {} } });
  assert.ok(parseQuery({ ...map, level: "country", country: "US" }).ok);
  const refused: [object, RegExp][] = [
    [{ measures: [{ measure: "context_cost", aggregation: "sum" }] }, /has no location/],
    [{ level: "country" }, /Choose the country/],
    [{ country: "US" }, /no country of its own/],
    [{ level: "country", country: "usa" }, /two letters/],
    [{ level: "city" }, /invalid at "level"/],
    [{ filters: { scorer: { id: SCORER } } }, /cannot be filtered by scorer/],
    [{ dimensions: ["model"] }, /invalid/],
  ];
  for (const [change, error] of refused) {
    const parsed = parseQuery({ ...map, ...change });
    assert.ok(!parsed.ok, JSON.stringify(change));
    assert.match(parsed.error, error);
  }
});

test("a SQL query carries its RQL text and the language version it was written in", () => {
  const given = { version: 1, kind: "sql", text: "select count(*) from traces", rqlVersion: 1 };
  assert.deepEqual(parseQuery(given), { ok: true, query: given });
  assert.ok(portableQuerySchema.safeParse(given).success);
  const refused: [object, RegExp][] = [
    [{ text: undefined }, /Write the RQL text of the query/],
    [{ text: "  " }, /Write the RQL text of the query/],
    [{ text: "x".repeat(MAX_SQL_TEXT + 1) }, /at most 4,000 characters/],
    [{ text: "select\0" }, /invalid at "text"|NUL/],
    [{ rqlVersion: undefined }, /Give the RQL version the query was written in/],
    [{ rqlVersion: 0 }, /Give the RQL version the query was written in/],
    [{ rqlVersion: 1.5 }, /Give the RQL version the query was written in/],
    [{ filters: {} }, /invalid/],
  ];
  for (const [change, says] of refused) {
    const parsed = parseQuery({ ...given, ...change });
    assert.ok(!parsed.ok, JSON.stringify(change));
    assert.match(parsed.error, says, JSON.stringify(change));
  }
});

test("a metric groups by a property: an object of its name, once, on a measure of traces", () => {
  const grouped = (measure: string, aggregation: string, dimensions: unknown[]) =>
    parseQuery({ ...BASE, measures: [{ measure, aggregation }], dimensions });
  const ok = grouped("latency", "p95", [{ property: "organization" }, "model"]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.query.kind === "metric" && ok.query.dimensions, [
    { property: "organization" },
    "model",
  ]);
  assert.ok(grouped("scorer_count", "count", [{ property: "plan" }]).ok);
  // The context measures have no trace.
  assert.match(
    (grouped("context_tokens", "sum", [{ property: "plan" }]) as { error: string }).error,
    /cannot be grouped by the property "plan"/,
  );
  assert.match(
    (grouped("latency", "p95", [{ property: "plan" }, { property: "plan" }]) as { error: string })
      .error,
    /twice/,
  );
  // A column property is its dimension, never a property.
  assert.match(
    (grouped("latency", "p95", [{ property: "user" }]) as { error: string }).error,
    /"user" is a column of every trace/,
  );
  for (const property of ["", " ", "k".repeat(101), "a\u0000b"])
    assert.ok(!grouped("latency", "p95", [{ property }]).ok, JSON.stringify(property));
  // The form's selection of a SQL query takes the same dimension.
  assert.ok(
    parseQuery({
      version: 1,
      kind: "sql",
      text: "select 1 from traces",
      rqlVersion: 1,
      form: {
        measures: [{ measure: "trace_count", aggregation: "count" }],
        dimensions: [{ property: "organization" }],
      },
    }).ok,
  );
});

test("user and session are dimensions of the measures of traces and of scores", () => {
  for (const dimension of ["user", "session"]) {
    assert.ok(DIMENSIONS.includes(dimension as never));
    assert.ok(parseQuery({ ...BASE, dimensions: [dimension] }).ok, dimension);
    assert.ok(
      parseQuery({
        ...BASE,
        measures: [{ measure: "scorer_count", aggregation: "count" }],
        dimensions: [dimension],
      }).ok,
    );
  }
});

test("a filter holds properties: of one name any value, names combine, in every clause", () => {
  const filtered = (filters: unknown) => parseQuery({ ...BASE, filters });
  const ok = filtered({
    properties: { organization: ["acme", "globex"], plan: ["pro"] },
    and: [{ properties: { release: ["1.2.0"] } }],
  });
  assert.ok(ok.ok);
  assert.deepEqual(ok.query.kind === "metric" && ok.query.filters.properties, {
    organization: ["acme", "globex"],
    plan: ["pro"],
  });
  // Every kind with a trace filter takes it.
  assert.ok(
    parseQuery({ ...stepFlowQuery("tool"), filters: { properties: { plan: ["pro"] } } }).ok,
  );
  assert.match(
    (filtered({ properties: { environment: ["prod"] } }) as { error: string }).error,
    /"environment" is a column of every trace/,
  );
  for (const properties of [
    { plan: [] },
    { plan: [""] },
    { plan: "pro" },
    { ["k".repeat(101)]: ["v"] },
    Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, ["v"]])),
  ])
    assert.ok(!filtered({ properties }).ok, JSON.stringify(properties).slice(0, 60));
});

test("a filter names users, sessions, tasks and the properties a trace has no value of", () => {
  const filters = {
    users: ["u1"],
    sessions: ["s1"],
    tasks: ["checkout"],
    withoutProperties: ["plan"],
    and: [{ withoutProperties: ["release"] }],
  };
  for (const query of [
    flowQuery("tool"),
    stepFlowQuery("tool"),
    geographyQuery("trace_count", "count"),
  ])
    assert.ok(parseQuery({ ...query, filters }).ok, query.kind);
  assert.deepEqual(queryProperties({ filters }), ["plan", "release"]);
  for (const withoutProperties of [["user"], [""], Array.from({ length: 21 }, (_, i) => `p${i}`)])
    assert.ok(
      !parseQuery({ ...flowQuery("tool"), filters: { withoutProperties } }).ok,
      JSON.stringify(withoutProperties).slice(0, 40),
    );
});

test("a metric takes users, sessions and tasks, and groups by task (RTL-397)", () => {
  assert.ok(parseQuery({ ...BASE, filters: { users: ["u1"], sessions: ["s1"] } }).ok);
  for (const filters of [{ tasks: ["checkout"] }, { and: [{ tasks: ["checkout"] }] }])
    assert.ok(parseQuery({ ...BASE, filters }).ok, JSON.stringify(filters));
  assert.ok(parseQuery({ ...BASE, dimensions: ["task"] }).ok);
  assert.ok(
    parseQuery({
      ...BASE,
      measures: [{ measure: "scorer_count", aggregation: "count" }],
      dimensions: ["task"],
    }).ok,
  );
  assert.ok(
    !parseQuery({
      ...BASE,
      measures: [{ measure: "context_tokens", aggregation: "sum" }],
      dimensions: ["task"],
    }).ok,
  );
});

test("flow, step flow, funnel and map group by one property, task, user or session (RTL-398)", () => {
  const funnel = {
    version: 1,
    kind: "funnel",
    steps: [
      { name: "a", condition: { type: "no_error" } },
      { name: "b", condition: { type: "no_error" } },
    ],
  };
  const kinds = [
    flowQuery("tool"),
    stepFlowQuery("tool"),
    funnel,
    geographyQuery("trace_count", "count"),
  ];
  for (const query of kinds) {
    for (const groupBy of ["task", "user", "session", { property: "plan" }])
      assert.ok(parseQuery({ ...query, groupBy }).ok, `${query.kind} ${JSON.stringify(groupBy)}`);
    assert.ok(parseQuery({ ...query, groupBy: "user", groupLimit: 12 }).ok, query.kind);
    for (const wrong of [
      { groupBy: "model" },
      { groupBy: { property: "" } },
      { groupBy: "user", groupLimit: 13 },
      { groupBy: "user", groupLimit: 0 },
      { groupLimit: 6 },
    ])
      assert.ok(!parseQuery({ ...query, ...wrong }).ok, `${query.kind} ${JSON.stringify(wrong)}`);
  }
  assert.ok(!parseQuery({ ...BASE, groupBy: "user" }).ok, "a metric groups by its dimensions");
  assert.ok(!parseQuery({ version: 1, kind: "clusters", view: "asks", groupBy: "user" }).ok);
  assert.deepEqual(queryProperties({ ...flowQuery("tool"), groupBy: { property: "plan" } }), [
    "plan",
  ]);
  assert.ok(
    portableQuerySchema.safeParse({ ...flowQuery("tool"), groupBy: { property: "plan" } }).success,
  );
});

test("a filter of the kinds names a user, a session or a task the trace has none of (RTL-398)", () => {
  const filters = { without: ["user", "session", "task"], and: [{ without: ["task"] }] };
  for (const query of [flowQuery("tool"), stepFlowQuery("tool")])
    assert.ok(parseQuery({ ...query, filters }).ok, query.kind);
  assert.ok(!parseQuery({ ...flowQuery("tool"), filters: { without: ["model"] } }).ok);
  assert.ok(!parseQuery({ ...BASE, filters: { without: ["user"] } }).ok, "a metric has no without");
});
