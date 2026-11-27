import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  flowQuery,
  funnelQuery,
  type GroupBy,
  geographyQuery,
  type Query,
  type QueryFilters,
  stepFlowQuery,
} from "@/lib/contracts/query";
import { type GroupedResult, runGrouped, topGroupValues } from "@/lib/synthesis/metrics/groups";
import { QueryError, runQuery } from "@/lib/synthesis/metrics/query";
import { OTHER_PROJECT, PROJECT, traceDatabase } from "@/lib/synthesis/metrics/trace-fixture";
import "@/lib/views/scorers/metrics";

/**
 * A group-by of the Flow, Step flow, Funnel and Map kinds (RTL-398): one small result per value,
 * the values of the most traces first, each the same query with the value as one more filter.
 *
 * t1 plan pro         user u1  session s1  US  search > read     task checkout
 * t2 plan pro         user u2  session s1  DE  read > answer     task checkout
 * t3 plan free        user u1  session s2  US  search > answer   task refund
 * t4 plan enterprise  user u3  session s3  FR  search            no task
 * t5 no plan          no user  no session  US  read              no task
 * o1 the other project: plan secret, user u9, session s9, task checkout of its own, US
 */

const SCOPE = { since: new Date("2026-11-02T00:00:00Z"), until: new Date("2026-11-03T00:00:00Z") };
const SEARCHED = { name: "Searched", condition: { type: "tool", name: "search" } } as const;
const NO_ERROR = { name: "No error", condition: { type: "no_error" } } as const;

let database: Awaited<ReturnType<typeof traceDatabase>>;

before(async () => {
  database = await traceDatabase();
  const trace = (
    id: string,
    at: string,
    tools: string[],
    root: { plan?: string; user?: string; session?: string; country: string },
    projectId = PROJECT,
  ) => ({
    id,
    projectId,
    startedAt: `2026-11-02T${at}:00Z`,
    root: {
      ...(root.user ? { endUserId: root.user } : {}),
      ...(root.session ? { sessionId: root.session } : {}),
      properties: root.plan ? { plan: root.plan } : null,
      attributes: { "ratel.geo.country": root.country },
    },
    spans: tools.map((tool) => ({ tool })),
  });
  await database.seed([
    trace("t1", "09:00", ["search", "read"], {
      plan: "pro",
      user: "u1",
      session: "s1",
      country: "US",
    }),
    trace("t2", "10:00", ["read", "answer"], {
      plan: "pro",
      user: "u2",
      session: "s1",
      country: "DE",
    }),
    trace("t3", "11:00", ["search", "answer"], {
      plan: "free",
      user: "u1",
      session: "s2",
      country: "US",
    }),
    trace("t4", "12:00", ["search"], {
      plan: "enterprise",
      user: "u3",
      session: "s3",
      country: "FR",
    }),
    trace("t5", "13:00", ["read"], { country: "US" }),
    trace(
      "o1",
      "14:00",
      ["search", "read"],
      { plan: "secret", user: "u9", session: "s9", country: "US" },
      OTHER_PROJECT,
    ),
  ]);
  const turn = (projectId: string, trace: string, task: string) =>
    `('${projectId}', 's', 'otlp:${trace}', 'otlp', 'otlp', 'closed', '2026-11-02T09:00:00Z', '2026-11-02T09:01:00Z', '2026-11-02T09:01:00Z', '${task}')`;
  await database.client.exec(`
    insert into trace_property_keys (project_id, name, state, source, seen_count) values
      ('${PROJECT}', 'plan', 'indexed', 'user', 4),
      ('${PROJECT}', 'tenant', 'detected', 'user', 1),
      ('${OTHER_PROJECT}', 'plan', 'indexed', 'user', 1);
    insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id) values
      ${[
        turn(PROJECT, "t1", "checkout"),
        turn(PROJECT, "t2", "checkout"),
        turn(PROJECT, "t3", "refund"),
        // The other project's run of a trace id this project has too: never this project's task.
        turn(OTHER_PROJECT, "t4", "secret-task"),
        turn(OTHER_PROJECT, "o1", "checkout"),
      ].join(",\n")};
  `);
});

after(() => database.client.close());

test("flow by a property: each small result is the flow filtered by its value, the most traces first", async () => {
  const query = flowQuery("tool", { groupBy: { property: "plan" } });
  const grouped = await runBy(query);
  assert.deepEqual(labels(grouped), ["pro 2", "enterprise 1", "free 1", "(none) 1"]);
  assert.equal(grouped.leftOut, 0);
  await assertEachIsFiltered(grouped, (filters) => flowQuery("tool", { filters }), "plan");
});

test("step flow by task: a value is a task of the project's own runs, the rest one group without", async () => {
  const query = stepFlowQuery("tool", { start: "none", groupBy: "task" });
  const grouped = await runBy(query);
  assert.deepEqual(labels(grouped), ["checkout 2", "(none) 2", "refund 1"]);
  await assertEachIsFiltered(
    grouped,
    (filters) => stepFlowQuery("tool", { start: "none", filters }),
    "task",
  );
});

test("funnel by user: the values of the most traces, and how many are left out", async () => {
  const query = funnelQuery([SEARCHED, NO_ERROR], { groupBy: "user", groupLimit: 2 });
  const grouped = await runBy(query);
  assert.deepEqual(labels(grouped), ["u1 2", "u2 1"]);
  // u3 and the traces without a user.
  assert.equal(grouped.leftOut, 2);
  await assertEachIsFiltered(
    grouped,
    (filters) => funnelQuery([SEARCHED, NO_ERROR], { filters }),
    "user",
  );
});

test("map by session: under the widget's filter and the page's, nothing of another project", async () => {
  const query = geographyQuery("trace_count", "count", { filters: { tools: ["search"] } });
  const grouped = await runBy({ ...query, groupBy: "session" }, PROJECT, {
    filter: { users: ["u1"] },
  });
  assert.deepEqual(labels(grouped), ["s1 1", "s2 1"]);
  await assertEachIsFiltered(
    grouped,
    (filters) =>
      geographyQuery("trace_count", "count", { filters: { tools: ["search"], ...filters } }),
    "session",
    { filter: { users: ["u1"] } },
  );
});

test("the values of one project never show in another's groups", async () => {
  for (const groupBy of ["task", "user", "session", { property: "plan" }] as GroupBy[]) {
    const ours = await runBy(flowQuery("tool", { groupBy }));
    const theirs = await runBy(flowQuery("tool", { groupBy }), OTHER_PROJECT);
    const values = (result: GroupedResult) => result.groups.map(({ value }) => value);
    for (const value of ["secret", "u9", "s9", "secret-task"])
      assert.ok(!values(ours).includes(value), `${JSON.stringify(groupBy)} ${value}`);
    for (const value of values(theirs))
      assert.ok(["secret", "u9", "s9", "checkout"].includes(value ?? ""), String(value));
  }
});

test("a group-by of a property that is not indexed is refused with its name", async () => {
  await assert.rejects(
    runBy(flowQuery("tool", { groupBy: { property: "tenant" } })),
    (error: unknown) => {
      assert.ok(error instanceof QueryError);
      assert.equal(error.detail?.code, "property_not_indexed");
      assert.equal(error.detail?.property, "tenant");
      return true;
    },
  );
});

function runBy(query: Query, projectId = PROJECT, scope: object = {}): Promise<GroupedResult> {
  const at = { ...SCOPE, ...scope };
  return runGrouped(projectId, query, {
    values: () => topGroupValues(projectId, query, at, database.db),
    run: (small) => runQuery(projectId, small, at, database.db),
  });
}

/** Each group's result equals the query of its value, written by hand. */
async function assertEachIsFiltered(
  result: GroupedResult,
  of: (filters: QueryFilters) => Query,
  by: "plan" | "task" | "user" | "session",
  scope: object = {},
) {
  for (const { value, result: small } of result.groups) {
    const filters: QueryFilters =
      by === "plan"
        ? value === null
          ? { withoutProperties: ["plan"] }
          : { properties: { plan: [value] } }
        : value === null
          ? { without: [by] }
          : { [`${by}s`]: [value] };
    const expected = await runQuery(PROJECT, of(filters), { ...SCOPE, ...scope }, database.db);
    assert.deepEqual(small, expected, `${by} ${value}`);
  }
}

function labels(result: GroupedResult): string[] {
  return result.groups.map(({ value, traces }) => `${value ?? "(none)"} ${traces}`);
}
