import assert from "node:assert/strict";
import { test } from "node:test";
import {
  draftMerge,
  draftRewrite,
  joinSearchable,
  mergedName,
  mergeSchemas,
  nameParts,
  triggerPhrases,
} from "@/lib/synthesis/tool-crafter/draft";
import {
  checkArgumentTypes,
  checkDispatch,
  checkParamCoverage,
  checkProposal,
  parseDerived,
  validateInputSchema,
} from "@/lib/synthesis/tool-crafter/schema-check";
import type { MergeEvidence, SourceTool } from "@/lib/synthesis/tool-crafter/types";

const find: SourceTool = {
  id: "find_task",
  name: "find_task",
  description: "Find a task by its title or key. Returns the task id and summary.",
  searchableDescription: "find task by title key search lookup",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Title or key" },
      limit: { type: "integer" },
    },
    required: ["query"],
  },
};
const assign: SourceTool = {
  id: "assign_task",
  name: "assign_task",
  description: "Assign a task to a teammate.",
  searchableDescription: "assign task teammate owner",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      assignee: { type: "string" },
      limit: { type: "string", description: "unrelated" },
    },
    required: ["taskId", "assignee"],
  },
};
const evidence = (over: Partial<MergeEvidence> = {}): MergeEvidence => ({
  scope: "turn",
  support: 40,
  unitsA: 40,
  unitsB: 41,
  jaccard: 40 / 41,
  jaccardLow: 0.91,
  pAb: 1,
  pBa: 40 / 41,
  nextP: 0.95,
  orderAb: 38,
  orderBa: 2,
  exampleSessions: ["s1"],
  ...over,
});

test("nameParts and mergedName read ids in any casing and keep a shared last word once", () => {
  assert.deepEqual(nameParts("findTask"), ["find", "task"]);
  assert.deepEqual(nameParts("find-task_v2"), ["find", "task", "v2"]);
  assert.equal(mergedName("find_task", "assign_task", true), "find_assign_task");
  assert.equal(mergedName("lookup", "report", true), "lookup_then_report");
  assert.equal(mergedName("lookup", "report", false), "lookup_or_report");
});

test("joinSearchable drops repeated words so BM25 does not saturate", () => {
  assert.equal(
    joinSearchable("find task by title", "assign task to a teammate"),
    "find task by title assign to a teammate",
  );
});

test("mergeSchemas shares same-shaped arguments, renames collisions on both sides, and unions required", () => {
  const { schema, mappings } = mergeSchemas([find, assign]);
  assert.deepEqual(Object.keys(schema.properties!).sort(), [
    "assign_task_limit",
    "assignee",
    "find_task_limit",
    "query",
    "taskId",
  ]);
  assert.deepEqual(mappings, {
    find_task: { limit: "find_task_limit" },
    assign_task: { limit: "assign_task_limit" },
  });
  assert.deepEqual(schema.required, ["assignee", "query", "taskId"]);
  assert.match(schema.properties!.assign_task_limit!.description!, /from assign_task/);
  const optional = mergeSchemas([find, assign], true);
  assert.equal(optional.schema.required, undefined);
});

test("a sequenced merge drafts one tool that runs A then B, with the evidence in its prose", () => {
  const proposal = draftMerge({
    a: find,
    b: assign,
    evidence: evidence(),
    catalogIds: new Set(["find_task", "assign_task"]),
  });
  assert.equal(proposal.kind, "merge_tools");
  const [tool] = proposal.crafted;
  assert.equal(tool!.name, "find_assign_task");
  assert.equal(
    tool!.description,
    "Find a task by its title or key, then assign a task to a teammate. One call does both; the agent no longer searches twice.",
  );
  assert.equal(tool!.inputSchema.properties!.mode, undefined, "a sequenced merge has no mode");
  assert.deepEqual(
    tool!.dispatch.map((d) => [d.sourceToolId, d.when]),
    [
      ["find_task", "always, as the first step"],
      ["assign_task", "always, as the second step, with what the first step returned"],
    ],
  );
  assert.deepEqual(proposal.hidden, ["find_task", "assign_task"]);
  assert.match(proposal.rationale, /40 of the turns .* \(98%\)/);
  assert.match(
    proposal.details,
    /95% of the time \(38 find_task-first against 2 assign_task-first\)/,
  );
  assert.match(
    proposal.migrationNotes,
    /find_task\.limit is now find_task_limit; assign_task\.limit is now assign_task_limit/,
  );
  assert.equal(
    checkProposal([find, assign], proposal, new Set(["find_task", "assign_task", "other"])).ok,
    true,
  );
});

test("a swapped-siblings merge drafts a mode argument and makes every other argument optional", () => {
  const proposal = draftMerge({
    a: find,
    b: assign,
    evidence: evidence({ nextP: 0.5, orderAb: 20, orderBa: 18 }),
    catalogIds: new Set(["find_task", "assign_task", "find_assign_task"]),
  });
  const [tool] = proposal.crafted;
  assert.equal(tool!.name, "find_assign_task_2", "steps aside from a catalog name");
  assert.deepEqual(tool!.inputSchema.properties!.mode!.enum, ["find_task", "assign_task"]);
  assert.deepEqual(tool!.inputSchema.required, ["mode"]);
  assert.match(tool!.description, /chosen by `mode`/);
  assert.match(proposal.details, /order varied/);
  const check = checkProposal(
    [find, assign],
    proposal,
    new Set(["find_task", "assign_task", "find_assign_task"]),
  );
  assert.equal(check.ok, true, JSON.stringify(check));
});

test("triggerPhrases keeps short distinct phrasings that add words, and a rewrite appends them", () => {
  const phrases = triggerPhrases("find task by title key search lookup", [
    "where is the ticket about billing",
    "which ticket covers billing",
    "find task by title",
    "where is the ticket about billing?",
    "x".repeat(100),
  ]);
  assert.deepEqual(phrases, ["which ticket covers billing", "where is the ticket about billing"]);
  const proposal = draftRewrite({
    tool: find,
    evidence: {
      missedQueries: ["where is the ticket about billing", "which ticket covers billing"],
      buriedQueries: [{ query: "open the issue for refunds", rank: 7 }],
      distractors: ["search_tasks"],
    },
  });
  assert.ok(proposal);
  assert.equal(proposal!.crafted[0]!.name, "find_task", "a rewrite keeps the name");
  assert.deepEqual(proposal!.crafted[0]!.inputSchema, find.inputSchema, "and the schema");
  assert.match(
    proposal!.crafted[0]!.searchableDescription,
    /^find task by title key search lookup Also asked as: /,
  );
  assert.match(proposal!.rationale, /missed by 2 queries and buried on 1/);
  assert.match(proposal!.details, /Outranked by search_tasks/);
  assert.equal(checkProposal([find], proposal!, new Set(["find_task"])).ok, true);
  assert.equal(
    draftRewrite({
      tool: find,
      evidence: { missedQueries: ["find task by title"], buriedQueries: [], distractors: [] },
    }),
    null,
    "nothing new to add is no proposal",
  );
});

test("validateInputSchema and checkParamCoverage reject what the catalog cannot take", () => {
  assert.equal(
    validateInputSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })
      .ok,
    true,
  );
  const bad = validateInputSchema({
    type: "array",
    properties: { a: {} },
    required: ["b"],
    x: { $ref: "#/x" },
  });
  assert.equal(bad.ok, false);
  assert.deepEqual((bad as { problems: string[] }).problems, [
    'input schema type is "array", not "object"',
    "property a has no type",
    "required names b, which is not a property",
    "$ref is not allowed",
  ]);
  const dropped = checkParamCoverage([find, assign], {
    kind: "merge_tools",
    hidden: [],
    crafted: [
      {
        name: "x",
        description: "",
        searchableDescription: "",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        outputNotes: null,
        dispatch: [],
      },
    ],
  });
  assert.deepEqual((dropped as { problems: string[] }).problems, [
    "assign_task: required argument taskId is neither kept, mapped nor derived",
    "assign_task: required argument assignee is neither kept, mapped nor derived",
  ]);
});

test("a derived argument covers a source's requirement, and checkDispatch holds the handler together", () => {
  const body = draftMerge({
    a: find,
    b: assign,
    evidence: evidence(),
    catalogIds: new Set(["find_task", "assign_task"]),
  });
  const problems = (check: ReturnType<typeof checkDispatch>) =>
    check.ok ? "" : check.problems.join(";");
  const tool = body.crafted[0]!;
  // The model's move: taskId comes from find_task's result, so the crafted tool no longer takes it.
  const schema = {
    ...tool.inputSchema,
    properties: Object.fromEntries(
      Object.entries(tool.inputSchema.properties ?? {}).filter(([k]) => k !== "taskId"),
    ),
    required: ["query", "assignee"],
  };
  const derivedBody = {
    ...body,
    crafted: [
      {
        ...tool,
        inputSchema: schema,
        dispatch: [
          { ...tool.dispatch[0]!, order: 0 },
          { ...tool.dispatch[1]!, order: 1, derived: { taskId: "find_task.output.id" } },
        ],
      },
    ],
  };
  assert.deepEqual(
    checkProposal([find, assign], derivedBody, new Set(["find_task", "assign_task"])),
    { ok: true },
  );

  const later = {
    ...derivedBody,
    crafted: [
      {
        ...derivedBody.crafted[0]!,
        dispatch: [
          { ...tool.dispatch[0]!, order: 1 },
          { ...tool.dispatch[1]!, order: 0, derived: { taskId: "find_task.output.id" } },
        ],
      },
    ],
  };
  assert.match(
    problems(checkDispatch([find, assign], later)),
    /derived from find_task, which runs after it/,
  );

  const invented = {
    ...derivedBody,
    crafted: [
      {
        ...derivedBody.crafted[0]!,
        inputSchema: {
          ...schema,
          properties: { ...schema.properties, urgency: { type: "string" } },
          required: ["query", "assignee", "urgency"],
        },
      },
    ],
  };
  assert.match(
    problems(checkDispatch([find, assign], invented)),
    /requires urgency, which no source tool required/,
  );

  const bad = {
    ...derivedBody,
    crafted: [
      {
        ...derivedBody.crafted[0]!,
        dispatch: [
          { ...tool.dispatch[0]!, order: 0 },
          { ...tool.dispatch[1]!, order: 1, derived: { taskId: "somewhere" } },
        ],
      },
    ],
  };
  assert.match(
    problems(checkDispatch([find, assign], bad)),
    /neither <source>\.output\.<path> nor literal:<json>/,
  );

  const noNote = {
    ...derivedBody,
    crafted: [{ ...derivedBody.crafted[0]!, dispatch: [derivedBody.crafted[0]!.dispatch[0]!] }],
  };
  assert.match(problems(checkDispatch([find, assign], noNote)), /assign_task: no dispatch note/);

  assert.deepEqual(parseDerived('literal:"open"'), { kind: "literal", value: "open" });
  assert.deepEqual(parseDerived("find_task.output.items.0.id"), {
    kind: "output",
    sourceToolId: "find_task",
    path: "items.0.id",
  });
  assert.equal(parseDerived("literal:{bad"), null);
});

test("tools that share a first word keep their clashing arguments apart", () => {
  const getUser: SourceTool = {
    id: "get_user",
    name: "get_user",
    description: "Get a user.",
    searchableDescription: null,
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  };
  const getTask: SourceTool = {
    id: "get_task",
    name: "get_task",
    description: "Get a task.",
    searchableDescription: null,
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  };
  const { schema, mappings } = mergeSchemas([getUser, getTask]);
  assert.deepEqual(schema.properties, {
    get_user_id: { type: "string" },
    get_task_id: { type: "integer", description: "id (from get_task)" },
  });
  assert.deepEqual(mappings, { get_user: { id: "get_user_id" }, get_task: { id: "get_task_id" } });
  assert.deepEqual(schema.required, ["get_task_id", "get_user_id"]);

  const proposal = draftMerge({
    a: getUser,
    b: getTask,
    evidence: evidence({ nextP: 0.95, orderAb: 38, orderBa: 1 }),
    catalogIds: new Set(["get_user", "get_task"]),
  });
  assert.deepEqual(checkProposal([getUser, getTask], proposal, new Set(["get_user", "get_task"])), {
    ok: true,
  });
});

test("a moved argument steps aside from a property already there", () => {
  const a: SourceTool = {
    id: "get_user",
    name: "get_user",
    description: "A.",
    searchableDescription: null,
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  };
  const b: SourceTool = {
    id: "get_task",
    name: "get_task",
    description: "B.",
    searchableDescription: null,
    inputSchema: {
      type: "object",
      properties: { get_user_id: { type: "boolean" }, id: { type: "integer" } },
    },
  };
  const { schema, mappings } = mergeSchemas([a, b]);
  assert.deepEqual(Object.keys(schema.properties!).sort(), [
    "get_task_id",
    "get_user_id",
    "get_user_id_2",
  ]);
  assert.equal(schema.properties!.get_user_id!.type, "boolean", "b's own argument keeps its name");
  assert.deepEqual(mappings, {
    get_user: { id: "get_user_id_2" },
    get_task: { id: "get_task_id" },
  });
});

test("checkArgumentTypes rejects a source argument mapped onto a property of another type", () => {
  const getUser: SourceTool = {
    id: "get_user",
    name: "get_user",
    description: "Get a user.",
    searchableDescription: null,
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  };
  const getTask: SourceTool = {
    id: "get_task",
    name: "get_task",
    description: "Get a task.",
    searchableDescription: null,
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  };
  // The draft the old stem rename produced: both ids on one string property.
  const collapsed = {
    crafted: [
      {
        name: "get_user_task",
        description: "d",
        searchableDescription: "s",
        inputSchema: { type: "object" as const, properties: { get_id: { type: "string" } } },
        outputNotes: null,
        dispatch: [
          {
            sourceToolId: "get_user",
            when: "always, as the first step",
            argumentMapping: { id: "get_id" },
          },
          {
            sourceToolId: "get_task",
            when: "always, as the second step",
            argumentMapping: { id: "get_id" },
          },
        ],
      },
    ],
  };
  const check = checkArgumentTypes([getUser, getTask], collapsed);
  assert.equal(check.ok, false);
  assert.deepEqual(!check.ok && check.problems, [
    'get_task: argument id is "integer" but get_user_task takes it as get_id, "string"',
  ]);
});
