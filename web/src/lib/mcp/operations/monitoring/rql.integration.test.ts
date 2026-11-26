import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { FlagSubject } from "@/lib/contracts/feature-flags";
import type { McpAuthContext } from "@/lib/mcp/auth";
import type { DispatchSuccess } from "@/lib/mcp/dispatch";
import { assembleOperations } from "@/lib/mcp/operations";
import { DAY_MS } from "@/lib/mcp/windows";
import { describeRqlSchema, RQL_LIMITS, RQL_VERSION } from "@/lib/synthesis/rql/compile";
import { dashboardReadOperations, EXAMPLES } from "./dashboards";
import { customMonitoringForCaller, rqlOperations } from "./rql";
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
} from "./test-support";

const MISSING = "44444444-4444-4444-8444-444444444444";
const FAST = "a".repeat(32);
const SLOW = "b".repeat(32);
const TRACES = "select trace_id, duration_ms, has_error from traces order by trace_id";
const SQL_QUERY = { version: 1, kind: "sql", text: TRACES, rqlVersion: RQL_VERSION };
const CALLS: [string, object][] = [
  ["describe_rql_schema", {}],
  ["run_rql", { text: TRACES }],
];

interface Table {
  summary: string;
  columns: { name: string; type: string }[];
  rows: unknown[][];
  truncated: boolean;
}

let m: Monitoring;

before(async () => {
  m = await monitoring((deps) => [...rqlOperations(deps), ...dashboardReadOperations(deps)]);
  await insertTrace(m.client, FAST, 80);
  await insertTrace(m.client, SLOW, 120, true);
});
beforeEach(() => {
  m.set.on = true;
});
after(() => m.client.close());

test("describe_rql_schema gives the language: tables, columns, functions, limits and examples", async () => {
  const data = await m.data("describe_rql_schema");
  assert.deepEqual(data, describeRqlSchema());
  assert.deepEqual(
    (data.tables as { name: string }[]).map(({ name }) => name),
    ["events", "traces", "scores", "sessions", "users"],
  );
});

test("run_rql gives the table: a summary first, then the columns, the rows and the cut", async () => {
  const result = (await m.call("run_rql", { text: TRACES })) as DispatchSuccess;
  assert.ok(result.ok, JSON.stringify(result));
  const data = result.data as Table;
  assert.equal(Object.keys(data)[0], "summary");
  assert.match(data.summary, /^2 rows of 3 columns: trace_id, duration_ms, has_error\./);
  assert.deepEqual(data.columns, [
    { name: "trace_id", type: "text" },
    { name: "duration_ms", type: "number" },
    { name: "has_error", type: "boolean" },
  ]);
  assert.deepEqual(data.rows, [
    [FAST, 80, false],
    [SLOW, 120, true],
  ]);
  assert.equal(data.truncated, false);
  assert.equal(result.truncated, undefined);
  // The default window is the one of RQL: the last 24 hours.
  assert.deepEqual(result.window, {
    since: new Date(NOW.getTime() - DAY_MS).toISOString(),
    until: NOW.toISOString(),
  });
});

test("run_rql reads the window it is given, and refuses a window over the most RQL reads", async () => {
  const before = await m.data<Table>("run_rql", {
    text: TRACES,
    until: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
  });
  assert.deepEqual(before.rows, []);
  assert.match(before.summary, /^No row\./);

  const wide = await m.call("run_rql", {
    text: TRACES,
    since: new Date(NOW.getTime() - 90 * DAY_MS).toISOString(),
  });
  assert.equal(wide.ok, false);
  assert.match(JSON.stringify(wide), new RegExp(`${RQL_LIMITS.maxWindowDays} days`));
});

test("run_rql says when the query had more rows than its limit", async () => {
  const result = (await m.call("run_rql", {
    text: "select trace_id from traces order by trace_id limit 1",
  })) as DispatchSuccess;
  assert.ok(result.ok);
  assert.equal((result.data as Table).truncated, true);
  assert.equal(result.truncated, true);
  assert.match((result.data as Table).summary, /more rows than its limit/);
});

test("an RQL error reaches the agent as RQL wrote it: the code, the message and the fix", async () => {
  const unknown = await m.call("run_rql", { text: "select trace_idd from traces" });
  assert.ok(!unknown.ok);
  assert.equal(unknown.error, "invalid_params");
  assert.equal(unknown.reason, "unknown_column");
  assert.match(unknown.message, /trace_idd/);
  assert.match(unknown.fix ?? "", /trace_id/);

  const join = await m.call("run_rql", {
    text: "select t.trace_id from traces t join events e on e.trace_id = t.trace_id",
  });
  assert.ok(!join.ok);
  assert.equal(join.reason, "join");
  assert.ok(join.fix);

  const newer = await m.call("run_rql", { text: TRACES, rqlVersion: RQL_VERSION + 1 });
  assert.ok(!newer.ok);
  assert.equal(newer.reason, "rql_version");
});

test("each RQL tool with and without access to the project", async () => {
  for (const [id, params] of CALLS) {
    const member = await m.call(id, { ...params, projectId: PROJECT }, personAuth("member"));
    assert.ok(member.ok, id);
    const other = await m.call(id, { ...params, projectId: OTHER });
    assert.equal(!other.ok && other.error, "forbidden", id);
    const stranger = await m.call(
      id,
      { ...params, projectId: PROJECT },
      personAuth("admin", MISSING),
    );
    assert.equal(!stranger.ok && stranger.error, "not_found", id);
  }
});

test("the RQL tools follow customMonitoring: off, each call is refused", async () => {
  for (const [id, params] of CALLS) assert.ok((await m.call(id, params)).ok, id);
  m.set.on = false;
  for (const [id, params] of CALLS) {
    const off = await m.call(id, params);
    assert.ok(!off.ok, id);
    assert.equal(off.error, "forbidden", id);
    assert.equal(off.reason, "custom_monitoring_off", id);
    assert.match(off.message, /customMonitoring/, id);
  }
});

test("the RQL tools are listed only with customMonitoring on", () => {
  const ids = (customMonitoring: boolean) =>
    assembleOperations({ customMonitoring }).map(({ id }) => id);
  for (const id of ["describe_rql_schema", "run_rql"]) {
    assert.ok(ids(true).includes(id), id);
    assert.ok(!ids(false).includes(id), id);
  }
  assert.deepEqual(
    ids(true).filter((id) => !ids(false).includes(id)),
    ["describe_rql_schema", "run_rql"],
  );
});

test("customMonitoring of a connection: an API key's project, or any organization of a person", async () => {
  const asked: FlagSubject[] = [];
  const on = (organizationId: string) => async (subject: FlagSubject) => {
    asked.push(subject);
    return subject.organizationId === organizationId;
  };
  assert.equal(await customMonitoringForCaller(KEY_AUTH, on(ORG)), true);
  assert.deepEqual(asked, [
    { organizationId: ORG, projectId: PROJECT, actor: `project:${PROJECT}` },
  ]);
  assert.equal(await customMonitoringForCaller(KEY_AUTH, on(MISSING)), false);
  const person: McpAuthContext = personAuth("member");
  assert.equal(await customMonitoringForCaller(person, on(ORG)), true);
  assert.equal(await customMonitoringForCaller(person, on(MISSING)), false);
  assert.equal(await customMonitoringForCaller(personAuth("member", MISSING), on(MISSING)), true);
});

test("query_monitoring runs a query of kind sql with customMonitoring on, and gives its table", async () => {
  const data = await m.data<{ summary: string; result: Table }>("query_monitoring", {
    query: SQL_QUERY,
  });
  assert.match(data.summary, /^2 rows of 3 columns/);
  assert.deepEqual(data.result, {
    kind: "sql",
    columns: [
      { name: "trace_id", type: "text" },
      { name: "duration_ms", type: "number" },
      { name: "has_error", type: "boolean" },
    ],
    rows: [
      [FAST, 80, false],
      [SLOW, 120, true],
    ],
    truncated: false,
  });
  // Its errors are the ones of RQL too.
  const wrong = await m.call("query_monitoring", {
    query: { ...SQL_QUERY, text: "select trace_idd from traces" },
  });
  assert.ok(!wrong.ok);
  assert.equal(wrong.reason, "unknown_column");
  assert.ok(wrong.fix);
});

test("query_monitoring refuses kind sql with customMonitoring off, and in panels always", async () => {
  m.set.on = false;
  const off = await m.call("query_monitoring", { query: SQL_QUERY });
  assert.ok(!off.ok);
  assert.equal(off.error, "forbidden");
  assert.equal(off.reason, "custom_monitoring_off");
  assert.match(off.message, /customMonitoring/);

  m.set.on = true;
  const panels = await m.call("query_monitoring", {
    queries: [{ query: EXAMPLES.metric }, { query: SQL_QUERY }],
  });
  assert.ok(!panels.ok);
  assert.equal(panels.error, "invalid_params");
  assert.match(panels.message, /kind sql cannot be a panel/);
});

test("describe_monitoring_schema lists kind sql, and refuses with customMonitoring off", async () => {
  const kinds = async () =>
    (
      await m.data<{ catalog: { kinds: { kind: string; note?: string }[] } }>(
        "describe_monitoring_schema",
        { part: "catalog" },
      )
    ).catalog.kinds;
  const sql = (await kinds()).find(({ kind }) => kind === "sql");
  assert.ok(sql);
  assert.match(sql.note ?? "", /run_rql/);
  assert.match(sql.note ?? "", /describe_rql_schema/);
  m.set.on = false;
  const off = await m.call("describe_monitoring_schema", { part: "catalog" });
  assert.ok(!off.ok);
  assert.equal(off.reason, "custom_monitoring_off");
});
