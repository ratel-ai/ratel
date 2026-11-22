import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { emptyChange } from "@/lib/views/eval-gate/change";
import { sessionReplayRuns } from "@/lib/views/session-replay/schema";
import type { WhatIfJobPayload } from "./runs";
import type { TimelineStep } from "./timeline";
import {
  addWhatIfToEvalSet,
  forkTargets,
  getWhatIfRun,
  isLive,
  listWhatIfRuns,
  sessionTools,
  submitWhatIf,
  type WhatIfDeps,
  withSessionToolsFirst,
} from "./what-if";

/**
 * RC-178: the What-if server actions check membership and the flag, follow
 * the content opt-in (replay only when it is on), build the variant on the
 * server, log `what_if_submitted`, and add the forked run to its task's eval set.
 */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "11111111-1111-4111-8111-111111111112";
const TURN = "33333333-3333-4333-8333-333333333331";
const LOOSE_TURN = "33333333-3333-4333-8333-333333333332";
const OTHER_TURN = "33333333-3333-4333-8333-333333333333";

type Db = ReturnType<typeof getDb>;

async function setup(options: { readContent?: boolean } = {}): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER_PROJECT}', '${ORG}', 'B', 'b');
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id) values
      ('${TURN}', '${PROJECT}', 'session-1', 'k1', 'declared', 'runtime', 'closed', now(), now(), now(), 'book-flight'),
      ('${LOOSE_TURN}', '${PROJECT}', 'session-1', 'k2', 'declared', 'runtime', 'closed', now(), now(), now(), null),
      ('${OTHER_TURN}', '${OTHER_PROJECT}', 'session-2', 'k3', 'declared', 'runtime', 'closed', now(), now(), now(), 'book-flight');
    insert into runtime_catalog_entries (project_id, kind, entry_id, name, description, searchable_description, searchable_description_overridden, content_hash) values
      ('${PROJECT}', 'tool', 'quote_fare', 'quote_fare', 'Quotes a fare.', 'quote fare price', false, 'h1');
  `);
  if (options.readContent !== undefined)
    await client.exec(
      `insert into session_replay_settings (project_id, read_content) values ('${PROJECT}', ${options.readContent})`,
    );
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

function deps(db: Db, over: Partial<WhatIfDeps> & { memberOf?: string[] } = {}) {
  const queued: WhatIfJobPayload[] = [];
  const tracked: unknown[] = [];
  const added: unknown[] = [];
  const memberOf = over.memberOf ?? [PROJECT];
  const value: WhatIfDeps = {
    db,
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) =>
      memberOf.includes(projectId)
        ? { project: { id: projectId }, organization: { id: ORG } }
        : null,
    resolveFix: async (_projectId, fixId) =>
      fixId === "craft:1"
        ? {
            craft: true,
            change: {
              ...emptyChange(),
              replay: {
                tools: [
                  {
                    name: "quote_fare",
                    description: "Quotes a fare, with taxes.",
                    parameters: { type: "object" },
                    replaces: [],
                  },
                ],
                failClearly: [],
                prerequisite: null,
                skill: null,
              },
            },
          }
        : fixId === "rewrite:1"
          ? {
              craft: false,
              change: { ...emptyChange(), patches: { quote_fare: "fare quote with taxes" } },
            }
          : null,
    request: {
      enqueue: async (_projectId, payload) => {
        queued.push(payload);
        return null;
      },
    },
    addToEvalSet: async (input) => {
      added.push(input);
      return { ok: true, message: "Run added." };
    },
    track: async (event) => {
      tracked.push(event);
    },
    ...over,
  };
  return { deps: value, queued, tracked, added };
}

const OVERRIDE = {
  kind: "catalog_override",
  tool: "quote_fare",
  searchable: "fare quote with taxes",
};

test("a member queues a re-rank while the content opt-in is off, and a model replay once it is on", async () => {
  for (const readContent of [false, true]) {
    const { client, db } = await setup({ readContent });
    try {
      const { deps: d, queued, tracked } = deps(db);
      const result = await submitWhatIf(
        { projectId: PROJECT, turnId: TURN, step: 0, k: 3, change: OVERRIDE },
        d,
      );
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.value.method, readContent ? "replay" : "rerank");
      assert.equal(result.value.status, "queued");
      assert.equal(result.value.k, 3);
      assert.equal(result.value.spentUsd, 0, "a queued run holds budget, it has spent nothing");
      assert.ok(isLive(result.value));
      assert.deepEqual(
        queued.map((payload) => payload.variant),
        [{ kind: "catalog_override", tool: "quote_fare", searchable: "fare quote with taxes" }],
      );
      assert.deepEqual(tracked, [
        {
          externalId: "user_1",
          projectId: PROJECT,
          organizationId: ORG,
          changeKind: "catalog_override",
          k: 3,
          method: result.value.method,
          runId: result.value.id,
        },
      ]);
    } finally {
      await client.close();
    }
  }
});

test("submitting the same change again returns the live run and tracks nothing new", async () => {
  const { client, db } = await setup();
  try {
    const { deps: d, tracked } = deps(db);
    const first = await submitWhatIf(
      { projectId: PROJECT, turnId: TURN, step: 0, change: OVERRIDE },
      d,
    );
    const second = await submitWhatIf(
      { projectId: PROJECT, turnId: TURN, step: 0, change: OVERRIDE },
      d,
    );
    assert.ok(first.ok && second.ok);
    assert.equal(second.value.id, first.value.id);
    assert.equal(first.value.k, 5, "k defaults to 5");
    assert.equal(tracked.length, 1);
  } finally {
    await client.close();
  }
});

test("a non-member and a signed-out caller are refused, and nothing is queued", async () => {
  const { client, db } = await setup();
  try {
    const input = { projectId: PROJECT, turnId: TURN, step: 0, change: OVERRIDE };
    const outsider = deps(db, { memberOf: [OTHER_PROJECT] });
    assert.deepEqual(await submitWhatIf(input, outsider.deps), {
      ok: false,
      error: "No project you belong to has that ID.",
    });
    assert.deepEqual(await submitWhatIf(input, deps(db, { getSession: async () => null }).deps), {
      ok: false,
      error: "Sign in to use What-if.",
    });
    assert.equal(outsider.queued.length, 0);
    assert.equal((await db.select().from(sessionReplayRuns)).length, 0);
  } finally {
    await client.close();
  }
});

test("bad input is refused: k above 10, a turn of another project, an unknown tool or fix", async () => {
  const { client, db } = await setup();
  try {
    const { deps: d } = deps(db);
    assert.deepEqual(
      await submitWhatIf({ projectId: PROJECT, turnId: TURN, step: 0, k: 11, change: OVERRIDE }, d),
      { ok: false, error: "The What-if settings are invalid." },
    );
    assert.deepEqual(
      await submitWhatIf({ projectId: PROJECT, turnId: TURN, step: 0, change: { kind: "fix" } }, d),
      { ok: false, error: "The What-if settings are invalid." },
    );
    assert.deepEqual(
      await submitWhatIf({ projectId: PROJECT, turnId: OTHER_TURN, step: 0, change: OVERRIDE }, d),
      { ok: false, error: "No run in this project has that ID." },
    );
    assert.deepEqual(
      await submitWhatIf(
        {
          projectId: PROJECT,
          turnId: TURN,
          step: 0,
          change: { kind: "remove_tool", tool: "nope" },
        },
        d,
      ),
      {
        ok: false,
        error: "No tool in this project's catalog has that name.",
      },
    );
    assert.deepEqual(
      await submitWhatIf(
        { projectId: PROJECT, turnId: TURN, step: 0, change: { kind: "fix", fixId: "issue:9" } },
        d,
      ),
      { ok: false, error: "That fix was replaced or is no longer open. Pick another." },
    );
  } finally {
    await client.close();
  }
});

test("the server builds the variant: a tool craft fix offers its crafted tools, an edited definition keeps the catalog's schema", async () => {
  const { client, db } = await setup();
  try {
    const { deps: d, queued } = deps(db);
    await submitWhatIf(
      { projectId: PROJECT, turnId: TURN, step: 0, change: { kind: "fix", fixId: "craft:1" } },
      d,
    );
    await submitWhatIf(
      { projectId: PROJECT, turnId: TURN, step: 0, change: { kind: "fix", fixId: "rewrite:1" } },
      d,
    );
    await submitWhatIf(
      {
        projectId: PROJECT,
        turnId: TURN,
        step: 1,
        change: {
          kind: "definition",
          tool: "quote_fare",
          description: "Quotes a fare, with taxes.",
        },
      },
      d,
    );
    assert.deepEqual(
      queued.map((payload) => payload.variant.kind),
      ["tool_craft", "fix", "definition"],
    );
    assert.deepEqual(queued[2]!.variant, {
      kind: "definition",
      tool: {
        name: "quote_fare",
        description: "Quotes a fare, with taxes.",
        parameters: { type: "object", properties: {} },
      },
    });
    const runs = await db.select({ ref: sessionReplayRuns.variantRef }).from(sessionReplayRuns);
    assert.deepEqual(runs.map((run) => run.ref).sort(), ["craft:1", "quote_fare", "rewrite:1"]);
  } finally {
    await client.close();
  }
});

test("a finished run reads back per sample, its choices largest first; another project's run is not found", async () => {
  const { client, db } = await setup();
  try {
    const { deps: d } = deps(db);
    const submitted = await submitWhatIf(
      { projectId: PROJECT, turnId: TURN, step: 0, k: 4, change: OVERRIDE },
      d,
    );
    assert.ok(submitted.ok);
    await db
      .update(sessionReplayRuns)
      .set({
        status: "completed",
        recordedTool: "find_booking",
        beforeTool: "find_booking",
        afterTool: "quote_fare",
        distribution: { before: { find_booking: 4 }, after: { "(answer)": 1, quote_fare: 3 } },
        tokens: {
          before: { input: 4_000, output: 80, costUsd: 0.04 },
          after: { input: 3_600, output: 80, costUsd: 0.032 },
        },
      })
      .where(eq(sessionReplayRuns.id, submitted.value.id));
    const read = await getWhatIfRun(PROJECT, submitted.value.id, d);
    assert.ok(read.ok);
    assert.equal(isLive(read.value), false);
    assert.deepEqual(read.value.after, {
      choice: "quote_fare",
      distribution: [
        { tool: "quote_fare", count: 3 },
        { tool: "(answer)", count: 1 },
      ],
      inputTokens: 900,
      outputTokens: 20,
      costUsd: 0.008,
    });
    assert.equal(read.value.before?.inputTokens, 1_000);
    assert.deepEqual(
      (await listWhatIfRuns(PROJECT, "session-1", db)).map((run) => run.id),
      [submitted.value.id],
    );
    const outsider = deps(db, { memberOf: [OTHER_PROJECT] });
    assert.deepEqual(await getWhatIfRun(OTHER_PROJECT, submitted.value.id, outsider.deps), {
      ok: false,
      error: "No What-if run in this project has that ID.",
    });
  } finally {
    await client.close();
  }
});

test("Add to eval set adds the forked run to its task's eval set; a run with no task is refused", async () => {
  const { client, db } = await setup();
  try {
    const { deps: d, added } = deps(db);
    const inTask = await submitWhatIf(
      { projectId: PROJECT, turnId: TURN, step: 0, change: OVERRIDE },
      d,
    );
    const loose = await submitWhatIf(
      { projectId: PROJECT, turnId: LOOSE_TURN, step: 0, change: OVERRIDE },
      d,
    );
    assert.ok(inTask.ok && loose.ok);
    assert.deepEqual(await addWhatIfToEvalSet(PROJECT, inTask.value.id, d), {
      ok: true,
      value: "Run added.",
    });
    assert.deepEqual(added, [
      { projectId: PROJECT, taskId: "book-flight", action: "add", runId: TURN },
    ]);
    assert.deepEqual(await addWhatIfToEvalSet(PROJECT, loose.value.id, d), {
      ok: false,
      error: "This run belongs to no task, so it has no eval set.",
    });
  } finally {
    await client.close();
  }
});

test("forkTargets numbers each model call from 0 inside its turn, by its step index", () => {
  const step = (index: number, turnId: string, kind: TimelineStep["kind"]) =>
    ({ index, turnId, kind }) as TimelineStep;
  const steps = [
    step(1, "a", "turn"),
    step(2, "a", "model_call"),
    step(3, "a", "tool_call"),
    step(4, "a", "model_call"),
    step(5, "b", "turn"),
    step(6, "b", "model_call"),
  ];
  assert.deepEqual(forkTargets({ steps }), {
    2: { turnId: "a", call: 0 },
    4: { turnId: "a", call: 1 },
    6: { turnId: "b", call: 0 },
  });
});

test("the panel offers the session's tools first, in the order the session met them", () => {
  const steps = [
    { index: 1, turnId: "a", kind: "search", hitIds: ["get_trace", "search_docs"] },
    { index: 2, turnId: "a", kind: "tool_call", targetId: "search_docs" },
    { index: 3, turnId: "a", kind: "tool_call", targetId: "list_traces" },
  ] as unknown as TimelineStep[];
  const first = sessionTools({ steps });
  assert.deepEqual(first, ["get_trace", "search_docs", "list_traces"]);
  const tool = (name: string) => ({ name, description: "", searchable: "" });
  const options = withSessionToolsFirst(
    { fixes: [], tools: ["a_tool", "list_traces", "get_trace", "z_tool", "search_docs"].map(tool) },
    first,
  );
  assert.deepEqual(
    options.tools.map((item) => item.name),
    ["get_trace", "search_docs", "list_traces", "a_tool", "z_tool"],
  );
});
