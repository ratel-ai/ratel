import assert from "node:assert/strict";
import test from "node:test";
import { draftMerge, draftRewrite } from "@/lib/synthesis/tool-crafter/draft";
import { kindGuide } from "@/lib/synthesis/tool-crafter/kinds";
import { promptFor } from "@/lib/synthesis/tool-crafter/prompt";
import { suggestionView } from "@/lib/synthesis/tool-crafter/suggestion-model";
import type { CraftCardModel } from "@/lib/synthesis/tool-crafter/view";

const card = (
  evidence: CraftCardModel["evidence"],
  kind: CraftCardModel["kind"],
  extra: Partial<CraftCardModel> = {},
): CraftCardModel =>
  ({
    id: "p",
    kind,
    status: "pending",
    sources: [],
    crafted: [],
    hidden: [],
    rationale: "",
    details: "",
    expectedEffect: "",
    migrationNotes: "",
    evidence,
    backtest: null,
    createdAt: new Date(0),
    ...extra,
  }) as unknown as CraftCardModel;

test("the prompt says the problem, the suggestion and the expected effect from the stored facts, the same text every time", () => {
  const enrich = card(
    {
      kind: "enrich_response",
      enrich: {
        intentId: "i",
        intentText: "close out",
        units: 20,
        a: "ctx",
        b: "projects",
        n: 19,
        na: 20,
        bMedianMs: 300,
        bUnitsOutside: 5,
      },
    },
    "enrich_response",
    {
      sources: [
        {
          id: "ctx",
          name: "ctx",
          description: "Loads the  working context\nfor a session.",
          searchableDescription: null,
          inputSchema: {
            type: "object",
            properties: { session: { type: "string" } },
            required: ["session"],
          },
        },
        {
          id: "projects",
          name: "projects",
          description: "Lists projects.",
          searchableDescription: null,
          inputSchema: null,
        },
      ],
    },
  );
  const view = suggestionView(enrich, (id) => id, [], {
    price: { ms: 1250, usd: 0.02, inputTokens: 4_000, outputTokens: 150, modelCalls: 80 },
  });
  const text = promptFor(view);
  assert.equal(text, promptFor(view), "deterministic");
  const [head, problem, suggestion, effect] = text.split(/\n## /);
  assert.match(
    head!,
    /^Ratel suggests a change to this agent's tools: Return what projects fetches in ctx's response/,
  );
  assert.match(
    problem!,
    /^Problem\nAfter the first tool answers, the agent always calls the second one/,
  );
  assert.match(
    problem!,
    /- ctx: Loads the working context for a session\. \(arguments: session\)\n- projects: Lists projects\./,
    "tools on one line each, whitespace folded",
  );
  assert.match(problem!, /Seen under the asks: "close out"/);
  assert.match(
    suggestion!,
    /^Suggestion\n- Add to ctx's response what the agent fetches with projects right after it/,
  );
  assert.doesNotMatch(suggestion!, /Drafted definition/, "a note-only kind drafts nothing");
  assert.match(effect!, /^Expected effect\n/);
  assert.match(effect!, /Per turn: 2 calls → 1, −1 round-trip, −300 ms waiting\./);
  assert.match(
    effect!,
    /Over the window · 19 turns: −19 round-trips \(24%\), −29 s waiting, −79k tokens, −\$0\.380\./,
  );
  assert.match(effect!, /Evidence strength: solid, seen 19 times in the window\./);
});

test("the kind guide lists every drafted kind once, with its verb and plain sentence", () => {
  const rows = kindGuide();
  assert.equal(rows.length, 12);
  assert.equal(new Set(rows.map((r) => r.kind)).size, 12);
  assert.deepEqual(rows[0], { kind: "merge_tools", verb: "Merge", plain: rows[0]!.plain });
  for (const row of rows) assert.ok(row.plain.length > 40 && row.verb.length > 0, row.kind);
});

test("a rewrite's drafted searchable text reaches the copied prompt, under the property the instruction names", () => {
  const tool = {
    id: "get_weather",
    name: "get_weather",
    description: "Read get_weather",
    searchableDescription: null,
    inputSchema: { type: "object" as const, properties: { city: { type: "string" } } },
  };
  const body = draftRewrite({
    tool,
    evidence: {
      missedQueries: ["tomorrow atmospheric forecast"],
      buriedQueries: [],
      distractors: [],
    },
  })!;
  assert.match(body.crafted[0]!.searchableDescription, /atmospheric/);
  const view = suggestionView(
    card(
      {
        kind: "rewrite_tool",
        rewrite: {
          missedQueries: ["tomorrow atmospheric forecast"],
          buriedQueries: [],
          distractors: [],
        },
      },
      "rewrite_tool",
      { sources: [tool], crafted: body.crafted },
    ),
    (id) => id,
    [],
  );
  const suggestion = promptFor(view).split(/\n## /)[2]!;
  assert.match(
    suggestion,
    /Set get_weather's searchable description .* to the `searchableDescription` below/,
  );
  const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(suggestion)![1]!) as Record<
    string,
    unknown
  >;
  assert.equal(json.searchableDescription, body.crafted[0]!.searchableDescription);
  assert.equal(json.description, "Read get_weather", "the description is left as it is");
});

test("a merge's drafted searchable text reaches the copied prompt", () => {
  const a = {
    id: "find_task",
    name: "find_task",
    description: "Finds a task.",
    searchableDescription: "Finds a task by title. Also asked as: locate ticket.",
    inputSchema: { type: "object" as const, properties: { title: { type: "string" } } },
  };
  const b = {
    id: "assign_task",
    name: "assign_task",
    description: "Assigns a task.",
    searchableDescription: null,
    inputSchema: { type: "object" as const, properties: { taskId: { type: "string" } } },
  };
  const evidence = {
    scope: "turn" as const,
    support: 40,
    unitsA: 40,
    unitsB: 41,
    jaccard: 0.9,
    jaccardLow: 0.8,
    pAb: 1,
    pBa: 0.98,
    nextP: 0.95,
    orderAb: 38,
    orderBa: 1,
    exampleSessions: [],
  };
  const body = draftMerge({ a, b, evidence, catalogIds: new Set(["find_task", "assign_task"]) });
  const view = suggestionView(
    card({ kind: "merge_tools", merge: evidence }, "merge_tools", {
      sources: [a, b],
      crafted: body.crafted,
    }),
    (id) => id,
    [],
  );
  assert.match(promptFor(view), /"searchableDescription": ".*locate ticket/);
});
