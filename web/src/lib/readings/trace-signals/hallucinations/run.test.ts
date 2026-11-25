import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClosedTurn } from "@/lib/ledger/closed-turns";
import { TimeBudgetError } from "@/lib/ledger/turn-pages";
import {
  type HallucinationRunDeps,
  recordHallucinations,
} from "@/lib/readings/trace-signals/hallucinations/run";
import type {
  CallFacts,
  HallucinationRowDraft,
} from "@/lib/readings/trace-signals/hallucinations/run-queries";
import { fresh, signalTurns } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import type { RunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

const WINDOW = { start: new Date("2020-01-01T00:00:00Z"), end: new Date("2100-01-01T00:00:00Z") };
const BASIS: RunBasis = { basis: "all", blocked: null, excludedRuns: 0, since: null, mixed: false };

type Facts = { errors?: Record<string, string>; requested?: Record<string, string> };

/** Facts by tool: every failed call of a tool gets its error, every call of a tool its requested name. Invented. */
function factsOf(turns: readonly SignalTurn[], facts: Facts): CallFacts {
  const out: CallFacts = { errors: new Map(), requested: new Map(), noSuchTool: new Set() };
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (!step.targetId) continue;
      const error = step.outcome === "error" ? facts.errors?.[step.targetId] : undefined;
      if (error !== undefined) out.errors.set(step.endTraceEventId ?? step.traceEventId, error);
      const requested = facts.requested?.[step.targetId];
      if (requested !== undefined) out.requested.set(step.traceEventId, requested);
    }
  }
  return out;
}

function harness(
  turns: readonly SignalTurn[],
  facts: Facts = {},
  over: Partial<HallucinationRunDeps> = {},
) {
  const store = { rows: [] as HallucinationRowDraft[], writes: 0, loads: 0 };
  const all = factsOf(turns, facts);
  const ordered = [...turns].sort(
    (a, b) => a.endedAt.getTime() - b.endedAt.getTime() || (a.id < b.id ? -1 : 1),
  );
  const deps: HallucinationRunDeps = {
    enabled: async () => true,
    listPage: async (_projectId, range, _db, limit = 500) => {
      const from = range.after ? ordered.findIndex((turn) => turn.id === range.after!.id) + 1 : 0;
      const page = ordered.slice(from, from + limit);
      const last = page.at(-1);
      return {
        // Owned: the ledger's page types `endedBy` as present; the fixtures leave it out.
        turns: page as ClosedTurn[],
        next: last ? { endedAtRaw: last.endedAt.toISOString(), id: last.id } : null,
      };
    },
    loadBasis: async () => BASIS,
    loadCallFacts: async (_projectId, ids) => {
      store.loads += 1;
      return {
        errors: new Map(
          ids.flatMap((id) => (all.errors.has(id) ? [[id, all.errors.get(id)!] as const] : [])),
        ),
        requested: new Map(
          ids.flatMap((id) =>
            all.requested.has(id) ? [[id, all.requested.get(id)!] as const] : [],
          ),
        ),
        noSuchTool: new Set(),
      };
    },
    loadCatalog: async () => null,
    loadReplyTexts: async () => new Map(),
    replaceRows: async (_projectId, _range, rows) => {
      store.writes += 1;
      store.rows = [...rows];
      return rows.length;
    },
    now: () => new Date(1_000),
    timeBudgetMs: 60_000,
    startedAt: 0,
    pageSize: 500,
    ...over,
  };
  return { store, run: () => recordHallucinations("project", { window: WINDOW }, deps) };
}

test("a window's findings are written once, with their counts", async () => {
  const turns = signalTurns([
    fresh({ session: "rerouted" }).invoke("entity_lookup"),
    fresh({ session: "missing" })
      .invoke("update_task")
      .error("update_task")
      .invoke("update_task")
      .error("update_task"),
    fresh({ session: "clean" }).invoke("create_task"),
  ]);
  const { store, run } = harness(turns, {
    requested: { entity_lookup: "get_task" },
    errors: { update_task: "Task not found" },
  });
  const result = await run();
  assert.deepEqual(result?.stored, {
    turns: 3,
    turnsAffected: 2,
    findings: 2,
    byKind: {
      unknown_tool: 0,
      tool_rerouted: 1,
      tool_action_changed: 0,
      unknown_reference: 1,
      value_not_allowed: 0,
      claimed_done_after_failure: 0,
      done_but_person_says_not: 0,
    },
    aliases: [],
  });
  assert.equal(store.writes, 1);
  assert.deepEqual(
    store.rows
      .map((row) => [row.kind, row.toolId, row.requestedToolId, row.repeats, row.worked])
      .sort(),
    [
      ["tool_rerouted", "entity_lookup", "get_task", 1, true],
      ["unknown_reference", "update_task", null, 2, false],
    ],
  );
});

test("a reply that says done, and a person whose next message says it was not, is a completion hallucination on its last call", async () => {
  const turns = signalTurns([
    fresh({ session: "said-done" }).invoke("list_prs").invoke("merge_pr"),
    fresh({ session: "fine" }).invoke("create_task"),
  ]);
  const endedAt = new Date("2026-11-18T10:00:00Z");
  const falseSuccess = async () => new Map([[turns[0]!.id, endedAt]]);
  // No reply read: nothing was claimed that can be shown false.
  const silent = harness(turns, {}, { loadFalseSuccessTurns: falseSuccess });
  assert.equal((await silent.run())?.stored.findings, 0);
  const { store, run } = harness(
    turns,
    {},
    {
      loadFalseSuccessTurns: falseSuccess,
      loadReplyTexts: async () => new Map([[turns[0]!.id, "Done, the PR is merged."]]),
    },
  );
  const result = await run();
  assert.equal(result?.stored.byKind.done_but_person_says_not, 1);
  assert.deepEqual(
    store.rows.map((row) => [
      row.kind,
      row.toolId,
      row.stepOrdinal,
      row.evidence,
      row.worked,
      row.occurredAt.toISOString(),
    ]),
    [
      [
        "done_but_person_says_not",
        "merge_pr",
        2,
        "person_says_not_done",
        false,
        endedAt.toISOString(),
      ],
    ],
  );
});

test("a name the runtime steadily maps to a tool, and that works there, is an alias; one that fails stays a finding", async () => {
  // get_task -> entity_lookup in 4 sessions, 6 calls, all working; get_document -> create_document in 3 sessions, all failing.
  const turns = signalTurns([
    ...["a", "b", "c", "d"].map((session, i) =>
      i < 2
        ? fresh({ session }).invoke("entity_lookup").invoke("entity_lookup")
        : fresh({ session }).invoke("entity_lookup"),
    ),
    ...["e", "f", "g"].map((session) =>
      fresh({ session })
        .invoke("create_document")
        .error("create_document")
        .invoke("create_document")
        .error("create_document"),
    ),
  ]);
  const { store, run } = harness(turns, {
    requested: { entity_lookup: "get_task", create_document: "get_document" },
  });
  const result = await run();
  assert.deepEqual(result?.stored.aliases, [
    { requestedToolId: "get_task", toolId: "entity_lookup", calls: 6, worked: 6, sessions: 4 },
  ]);
  assert.deepEqual(
    [...new Set(store.rows.map((row) => `${row.requestedToolId}>${row.toolId}`))],
    ["get_document>create_document"],
  );
});

test("a requested name that also ran under its own name in the window is an alias, not a made-up tool", async () => {
  const turns = signalTurns([
    fresh({ session: "a" }).invoke("entity_lookup"),
    fresh({ session: "b" }).invoke("get_task"),
  ]);
  // Only the first session's call carries a requested name; the second ran `get_task` itself.
  const { store, run } = harness(
    turns,
    {},
    {
      loadCallFacts: async (_projectId, ids) => ({
        errors: new Map(),
        requested: new Map(
          ids.includes(turns[0]!.steps[0]!.traceEventId)
            ? [[turns[0]!.steps[0]!.traceEventId, "get_task"]]
            : [],
        ),
        noSuchTool: new Set(),
      }),
    },
  );
  assert.equal((await run())?.stored.findings, 0);
  assert.deepEqual(store.rows, []);
});

test("a requested name whose own-name calls all failed is no alias: the reroute stays a finding", async () => {
  const turns = signalTurns([
    fresh({ session: "a" }).invoke("entity_lookup"),
    fresh({ session: "b" }).invoke("get_task").error("get_task"),
  ]);
  // The second session called `get_task` itself, and it failed: that says nothing about the name.
  const { run } = harness(
    turns,
    { errors: { get_task: "Unknown tool: get_task" } },
    {
      loadCallFacts: async (_projectId, ids) => ({
        errors: new Map(
          ids.includes(turns[1]!.steps[0]!.traceEventId)
            ? [[turns[1]!.steps[0]!.traceEventId, "Unknown tool: get_task"]]
            : [],
        ),
        requested: new Map(
          ids.includes(turns[0]!.steps[0]!.traceEventId)
            ? [[turns[0]!.steps[0]!.traceEventId, "get_task"]]
            : [],
        ),
        noSuchTool: new Set(),
      }),
    },
  );
  const result = await run();
  assert.ok((result?.stored.findings ?? 0) >= 1, "the reroute of a name that never worked is kept");
});

test("a tool whose error said it does not exist, but that worked elsewhere in the window, exists", async () => {
  const turns = signalTurns([
    fresh({ session: "a" }).invoke("merge_tasks").error("merge_tasks"),
    fresh({ session: "b" }).invoke("merge_tasks"),
  ]);
  const { run } = harness(turns, { errors: { merge_tasks: "Unknown tool: merge_tasks" } });
  assert.equal((await run())?.stored.findings, 0);
});

test("switched off, the reading loads nothing and writes nothing", async () => {
  const turns = signalTurns([fresh({ session: "a" }).invoke("entity_lookup")]);
  const { store, run } = harness(
    turns,
    { requested: { entity_lookup: "get_task" } },
    { enabled: async () => false },
  );
  assert.equal(await run(), null);
  assert.deepEqual([store.loads, store.writes], [0, 0]);
  // A switch that cannot be decided is off.
  const failing = harness(
    turns,
    {},
    { enabled: async () => Promise.reject(new Error("flags down")) },
  );
  assert.equal(await failing.run(), null);
});

test("over the time budget, nothing is written", async () => {
  const turns = signalTurns([fresh({ session: "a" }).invoke("entity_lookup")]);
  const { store, run } = harness(
    turns,
    { requested: { entity_lookup: "get_task" } },
    { now: () => new Date(120_000) },
  );
  await assert.rejects(run, TimeBudgetError);
  assert.equal(store.writes, 0);
});

test("replies are loaded only for turns where a false done could be read", async () => {
  const turns = signalTurns([
    fresh({ session: "undone" })
      .invoke("update_task")
      .invoke("add_task_comment")
      .error("add_task_comment"),
    fresh({ session: "clean" }).invoke("update_task"),
  ]);
  const asked: string[] = [];
  const { store, run } = harness(
    turns,
    {},
    {
      loadReplyTexts: async (_projectId, list) => {
        asked.push(...list.map(([turnId]) => turnId));
        return new Map(
          list.map(([turnId]) => [turnId, "Done. RS-202 is closed and Ada has been notified."]),
        );
      },
    },
  );
  await run();
  assert.deepEqual(asked, [turns[0]!.id]);
  assert.deepEqual(
    store.rows.map((row) => [row.kind, row.toolId]),
    [["claimed_done_after_failure", "add_task_comment"]],
  );
});
