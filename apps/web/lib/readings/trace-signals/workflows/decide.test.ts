import assert from "node:assert/strict";
import { test } from "node:test";
import type { JudgeEngine } from "@/lib/readings/decisions/judge";
import { judgeFraming } from "@/lib/readings/decisions/openai-judge";
import {
  type AskGroup,
  aggregateDecisions,
  askHash,
  decisionCases,
  decisionOptions,
  hashText,
  NONE_OPTION_ID,
  normalizeAsk,
  optionsHash,
  preferUserAsks,
  WORKFLOW_FRAMING,
} from "./decide";
import {
  type DecideDeps,
  decideMaxUsd,
  decideProjectWorkflows,
  workflowJudgeFromEnv,
} from "./decide-job";

const WORKFLOWS = [
  {
    id: "wf-release",
    typicalOrder: ["find_pr", "link_pr_to_task", "update_status"],
    coreTools: ["find_pr", "link_pr_to_task", "update_status"],
  },
  {
    id: "wf-sprint",
    typicalOrder: ["list_projects", "get_backlog"],
    coreTools: ["get_backlog", "list_projects"],
  },
];

const RELEASE = ["find_pr", "link_pr_to_task", "update_status"];
const turn = (id: string, tools: string[], errors = 0) => ({
  id,
  errors,
  invokes: tools.length,
  tools,
});
const LABELS = new Map([
  ["wf-release", { name: "Close out a release", description: "Links the PR and closes the task." }],
]);

const GROUPS: AskGroup[] = [
  // One full run, one that stopped after find_pr with an error, one that served it with one tool.
  {
    ask: "Close out release 4.2",
    turns: [turn("t1", RELEASE), turn("t2", ["find_pr"], 1), turn("t8", ["update_status"])],
  },
  { ask: "export the board as PDF", turns: [turn("t3", ["get_board_summary"], 1)] },
  // One run never called a tool; one answered with a tool and no error.
  { ask: "Export board to pdf please", turns: [turn("t4", []), turn("t5", ["get_board_summary"])] },
  { ask: "hmm", turns: [turn("t6", ["x"])] },
  { ask: "read the pricing FAQ", turns: [turn("t7", ["read_document"])] },
];

test("options name each workflow, describe its steps, and end with none", () => {
  const options = decisionOptions(WORKFLOWS, LABELS);
  assert.deepEqual(
    options.map((o) => o.entryId),
    ["wf-release", "wf-sprint", NONE_OPTION_ID],
  );
  assert.equal(options[0].name, "Close out a release");
  assert.match(
    options[0].description ?? "",
    /Links the PR.*Runs find_pr, then link_pr_to_task, then update_status/,
  );
  assert.equal(options[1].name, "list_projects > get_backlog");
  assert.notEqual(optionsHash(options), optionsHash(decisionOptions(WORKFLOWS)));
});

test("the judge carries the workflow framing, and the default stays the tuned tool framing", () => {
  assert.deepEqual(judgeFraming(WORKFLOW_FRAMING), WORKFLOW_FRAMING);
  assert.match(judgeFraming().about, /tool search/);
});

test("aggregate places asks, counts unclear, and groups asks no workflow serves", () => {
  const verdicts = new Map([
    [hashText(normalizeAsk(GROUPS[0].ask)), { entryId: "wf-release" }],
    [hashText(normalizeAsk(GROUPS[1].ask)), { entryId: NONE_OPTION_ID }],
    [hashText(normalizeAsk(GROUPS[2].ask)), { entryId: NONE_OPTION_ID }],
    [hashText(normalizeAsk(GROUPS[3].ask)), { entryId: "" }],
    [hashText(normalizeAsk(GROUPS[4].ask)), { entryId: NONE_OPTION_ID }],
  ]);
  const out = aggregateDecisions(GROUPS, verdicts, WORKFLOWS);
  assert.deepEqual(
    out.placed,
    { "wf-release": { turns: 3, outside: 1, outsideWithErrors: 1 } },
    "only the failed early stop counts; a run served with fewer tools does not",
  );
  assert.equal(out.unclear, 1);
  assert.equal(out.judged, 5);
  assert.equal(
    out.unserved.length,
    1,
    "both PDF asks land in one group; the FAQ run was resolved by a tool",
  );
  assert.equal(out.unserved[0].turns, 2, "only the unresolved PDF runs count");
  assert.deepEqual(out.unserved[0].turnIds, ["t3", "t4"]);
});

function fakeJudge(calls: string[][]): JudgeEngine {
  return {
    model: "test-judge",
    judge: async (cases) => {
      calls.push(cases.map((c) => c.query));
      return cases.map((c) => ({
        id: c.id,
        entryId: /release/i.test(c.query)
          ? "wf-release"
          : /pdf/i.test(c.query)
            ? NONE_OPTION_ID
            : "",
        confident: true,
        confidence: 0.95,
      }));
    },
  };
}

function deps(over: Partial<DecideDeps> = {}) {
  const saved: { verdicts: unknown[]; insights: unknown[] } = { verdicts: [], insights: [] };
  const calls: string[][] = [];
  const d: DecideDeps = {
    judge: fakeJudge(calls),
    toolJudge: null,
    loadToolCorpus: async () => [],
    loadRecentAskGroups: async () => GROUPS,
    loadVerdicts: async () => new Map(),
    saveVerdicts: async (_p, _h, _m, rows) => {
      saved.verdicts.push(...rows);
    },
    saveInsights: async (_p, data) => {
      saved.insights.push(data);
    },
    now: () => new Date("2026-10-01T00:00:00Z"),
    ...over,
  };
  return { d, saved, calls };
}

test("the job judges uncached asks only, caches verdicts and stores insights", async () => {
  const cachedHash = decisionCases([GROUPS[0]])[0].id;
  const { d, saved, calls } = deps({
    loadVerdicts: async () => new Map([[cachedHash, { entryId: "wf-release" }]]),
  });
  const result = await decideProjectWorkflows("p1", WORKFLOWS, LABELS, d);
  assert.deepEqual(result, { asks: 5, judged: 4, cached: 1, skipped: null });
  assert.deepEqual(calls, [
    ["export the board as PDF", "Export board to pdf please", "hmm", "read the pricing FAQ"],
  ]);
  assert.deepEqual(
    (saved.verdicts as { verdict: string }[]).map((v) => v.verdict),
    ["none", "none", "unclear", "unclear"],
  );
  assert.equal(saved.insights.length, 1);
});

test("no key, no workflows, no asks or a failing judge never throw", async () => {
  assert.equal(
    (await decideProjectWorkflows("p1", WORKFLOWS, LABELS, deps({ judge: null }).d)).skipped,
    "no_judge",
  );
  assert.equal((await decideProjectWorkflows("p1", [], LABELS, deps().d)).skipped, "no_workflows");
  assert.equal(
    (
      await decideProjectWorkflows(
        "p1",
        WORKFLOWS,
        LABELS,
        deps({ loadRecentAskGroups: async () => [] }).d,
      )
    ).skipped,
    "no_asks",
  );
  const broken = deps({
    judge: {
      model: "x",
      judge: async () => {
        throw new Error("the engine rejected the API key (401)");
      },
    },
  });
  const result = await decideProjectWorkflows("p1", WORKFLOWS, LABELS, broken.d);
  assert.equal(result.skipped, "failed");
  assert.equal(broken.saved.insights.length, 0, "previous insights stay in place");
});

test("asks no workflow fits are missing only when no tool does them either", () => {
  const verdicts = new Map([
    [askHash(GROUPS[1]), { entryId: NONE_OPTION_ID }],
    [askHash(GROUPS[2]), { entryId: NONE_OPTION_ID }],
    [askHash(GROUPS[4]), { entryId: NONE_OPTION_ID }],
  ]);
  // The PDF asks: no tool does it, so every run counts, even the one that ran a tool fine.
  // The FAQ ask: read_document does it, so it is not missing.
  const tools = new Map([
    [askHash(GROUPS[1]), { entryId: NONE_OPTION_ID }],
    [askHash(GROUPS[2]), { entryId: NONE_OPTION_ID }],
    [askHash(GROUPS[4]), { entryId: "read_document" }],
  ]);
  const out = aggregateDecisions(GROUPS, verdicts, WORKFLOWS, tools);
  assert.equal(out.unserved.length, 1);
  assert.equal(
    out.unserved[0].turns,
    3,
    "t3, t4 and t5: the run that called a tool fine still did not export a PDF",
  );
});

test("the tool check asks only about unplaced asks, with none on every shortlist", async () => {
  const toolCalls: { queries: string[]; shortlists: string[][]; options: string[] }[] = [];
  const toolJudge: JudgeEngine = {
    model: "test-tools",
    judge: async (cases, corpus) => {
      toolCalls.push({
        queries: cases.map((c) => c.query),
        shortlists: cases.map((c) => c.shortlist),
        options: corpus.map((e) => e.entryId),
      });
      return cases.map((c) => ({
        id: c.id,
        entryId: /faq/i.test(c.query) ? "read_document" : NONE_OPTION_ID,
        confident: true,
        confidence: 0.92,
      }));
    },
  };
  const corpus = [
    {
      entryId: "read_document",
      name: "read_document",
      searchable: "Read a document",
      source: "runtime",
      matchesAgentDescription: true,
      tags: [],
    },
  ];
  const { d, saved } = deps({ toolJudge, loadToolCorpus: async () => corpus });
  await decideProjectWorkflows("p1", WORKFLOWS, LABELS, d);
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(toolCalls[0].queries, ["export the board as PDF", "Export board to pdf please"]);
  assert.ok(toolCalls[0].shortlists.every((list) => list.includes(NONE_OPTION_ID)));
  assert.deepEqual(toolCalls[0].options, ["read_document", NONE_OPTION_ID]);
  const insights = saved.insights[0] as { unserved: { turns: number }[] };
  assert.equal(insights.unserved[0].turns, 3);
});

test("users' own asks win once there are enough; below that, search stand-ins fill in", () => {
  const ask = (source: "user" | "search", i: number) => ({ source, text: `${source} ${i}` });
  const fewUsers = [
    ...Array.from({ length: 5 }, (_, i) => ask("user", i)),
    ...Array.from({ length: 40 }, (_, i) => ask("search", i)),
  ];
  assert.equal(preferUserAsks(fewUsers).length, 45, "5 users' asks are too few to judge alone");
  const enough = [
    ...Array.from({ length: 30 }, (_, i) => ask("user", i)),
    ...Array.from({ length: 40 }, (_, i) => ask("search", i)),
  ];
  const kept = preferUserAsks(enough);
  assert.equal(kept.length, 30);
  assert.ok(
    kept.every((a) => a.source === "user"),
    "the fixed runs alone",
  );
});

test("the insights count where the judged asks came from", () => {
  const groups: AskGroup[] = [
    { ask: "close out release 4.2", turns: [turn("u1", RELEASE)], source: "user" },
    { ask: "find pr", turns: [turn("s1", RELEASE)], source: "search" },
    { ask: "older ask", turns: [turn("o1", RELEASE)] },
  ];
  const verdicts = new Map(
    groups.map((g) => [hashText(normalizeAsk(g.ask)), { entryId: "wf-release" }]),
  );
  const out = aggregateDecisions(groups, verdicts, WORKFLOWS);
  assert.deepEqual(
    out.sources,
    { user: 2, search: 1 },
    "an ask without a source reads as the user's",
  );
});

test("the job's spend ceiling is priced at the engine's list price, and absent without a key", () => {
  assert.equal(decideMaxUsd({ OPENAI_API_KEY: "o" }), 0.3);
  assert.equal(decideMaxUsd({}), undefined);
});

test("the workflow judge is the OpenAI engine for both framings, and null without a key", () => {
  assert.equal(workflowJudgeFromEnv({ OPENAI_API_KEY: "o" })?.model, "gpt-6-luna");
  assert.equal(workflowJudgeFromEnv({ OPENAI_API_KEY: "o" }, true)?.model, "gpt-6-luna");
  assert.equal(workflowJudgeFromEnv({}), null);
  assert.equal(
    workflowJudgeFromEnv({ OPENAI_API_KEY: "REPLACE_ME" }),
    null,
    "a placeholder seed is no key",
  );
});
