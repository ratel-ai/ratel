import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLevels, type LevelInput } from "@/lib/readings/intent-engine/levels";
import { VerbLexicon } from "@/lib/readings/intent-engine/text";

const c = (uuid: string, members: string[], tools: string[] = [], weight = 3): LevelInput => ({
  uuid,
  members,
  tools,
  weight,
});

const SEVEN = [
  c("a1", ["assign this task to emp-1"], ["acme__assign_task"], 5),
  c("a2", ["assign this task to emp-2"], ["acme__assign_task"], 4),
  c("a3", ["assign this task to emp-3"], ["acme__assign_task"], 3),
  c("cr", ["create task"], ["acme__create_task"], 6),
  c("up", ["update task"], ["acme__update_task"], 2),
  c("ck", ["check the CI tests"], ["github__ci_status"], 7),
  c("fx", ["fix the CI tests"], ["github__ci_rerun"], 1),
];

test("the seven intents climb to two topics, then stop", () => {
  const tree = buildLevels(SEVEN, [], new VerbLexicon());
  assert.equal(tree.levels.length, 3, "levels 1 and 2 always exist; level 3 merges nothing");
  const l1 = tree.levels[1];
  assert.equal(l1.length, 5);
  const assign = l1.find((n) => n.children.includes("a1"))!;
  assert.deepEqual([...assign.children].sort(), ["a1", "a2", "a3"]);
  assert.equal(assign.label, "assign this task to {id}");
  assert.notEqual(
    tree.parentOf.get("ck"),
    tree.parentOf.get("fx"),
    "check and fix stay apart at level 1",
  );
  const l2 = tree.levels[2];
  assert.equal(l2.length, 2);
  const labels = l2.map((n) => n.label).sort();
  assert.deepEqual(labels, ["CI operations", "Task operations"]);
});

test("ids carry over when a group keeps most of its children", () => {
  const first = buildLevels(SEVEN, [], new VerbLexicon());
  const prior = first.levels.flatMap((nodes) =>
    nodes.map((n) => ({ uuid: n.uuid, level: n.level, children: n.children })),
  );
  const again = buildLevels(
    [...SEVEN, c("a4", ["assign this task to emp-4"], ["acme__assign_task"], 1)],
    prior,
    new VerbLexicon(),
  );
  const before = first.parentOf.get("a1");
  assert.equal(again.parentOf.get("a1"), before);
  assert.equal(again.parentOf.get("a4"), before);
});

test("nothing to merge: levels 1 and 2 hold one node per cluster, and nothing above", () => {
  const tree = buildLevels(
    [c("x", ["refund an order"]), c("y", ["book a meeting room"])],
    [],
    new VerbLexicon(),
  );
  assert.equal(tree.levels.length, 3);
  assert.equal(tree.levels[1].length, 2);
  assert.equal(tree.levels[2].length, 2);
});

test("level 0 already merged the variants: level 2 still groups by object", () => {
  const tree = buildLevels(
    [
      c("as", ["assign this task to emp-1", "assign this task to emp-2"]),
      c("cr", ["create task"]),
      c("up", ["update task"]),
    ],
    [],
    new VerbLexicon(),
  );
  assert.equal(tree.levels[1].length, 3);
  assert.equal(tree.levels[2].length, 1);
  assert.equal(tree.levels[2][0].label, "Task operations");
});

test("names group at level 1 as values; asks that would lose every shared word do not", () => {
  const tree = buildLevels(
    [
      c("al", ["assign this task to alice"], [], 3),
      c("bo", ["assign this task to bob"], [], 2),
      c("st", ["summarize yesterday standup notes"], [], 2),
      c("cu", ["summarize customer feedback"], [], 1),
    ],
    [],
    new VerbLexicon(),
  );
  assert.equal(tree.parentOf.get("al"), tree.parentOf.get("bo"));
  assert.notEqual(tree.parentOf.get("st"), tree.parentOf.get("cu"));
  const assign = tree.levels[1].find((n) => n.children.includes("al"))!;
  assert.equal(assign.label, "assign this task to {value}");
});

test("one stray action in a cluster does not merge it into that action's intent", () => {
  const tree = buildLevels(
    [
      c(
        "cm",
        [
          "add comment on task",
          "add a comment to the task",
          "add task comment",
          "create task comment on task",
        ],
        ["acme__add_task_comment"],
        9,
      ),
      c(
        "cr",
        ["create task", "create a task in project", "create task with assignee"],
        ["acme__create_task"],
        6,
      ),
    ],
    [],
    new VerbLexicon(),
  );
  assert.notEqual(
    tree.parentOf.get("cm"),
    tree.parentOf.get("cr"),
    "comment's dominant action is add, not create",
  );
});

test("asks with no lead verb never group at level 1, and still reach their topic", () => {
  const tree = buildLevels(
    [c("p1", ["project tasks overview"], [], 3), c("p2", ["project tasks for this sprint"], [], 2)],
    [],
    new VerbLexicon(),
  );
  assert.notEqual(
    tree.parentOf.get("p1"),
    tree.parentOf.get("p2"),
    "no shared action to group on at level 1",
  );
  const l1 = (id: string) => tree.parentOf.get(id)!;
  assert.equal(
    tree.parentOf.get(l1("p1")),
    tree.parentOf.get(l1("p2")),
    "both are about project tasks at level 2",
  );
});

test("dominantVerb ignores verb-less phrases and needs half of the votes", async () => {
  const { dominantVerb } = await import("@/lib/readings/intent-engine/levels");
  const v = new VerbLexicon();
  assert.equal(
    dominantVerb(["add comment", "add a comment", "project comments", "create comment"], v),
    "add",
  );
  assert.equal(dominantVerb(["project tasks", "tasks overview"], v), null);
  assert.equal(
    dominantVerb(["add comment", "create task", "list tasks"], v),
    null,
    "no verb holds half",
  );
});

test("one bridging phrase does not group two otherwise unrelated intents", () => {
  const tree = buildLevels(
    [
      c(
        "cm",
        [
          "add comment on task",
          "add a comment to the task",
          "add task comment",
          "add tags to task",
        ],
        ["acme__add_task_comment"],
        9,
      ),
      c(
        "tg",
        ["add tags to task", "add tags to a task", "add task tags"],
        ["acme__add_tag_to_task"],
        5,
      ),
      // A real project's background: its nouns recur across clusters (alone in one they
      // read as values), and "add" and "task" are everywhere, so they weigh little.
      c("ec", ["edit comment on task"], ["acme__edit_task_comment"], 2),
      c("rt", ["remove tags from task"], ["acme__remove_tag_from_task"], 2),
      ...[
        "create task",
        "update task",
        "delete task",
        "assign task",
        "move task",
        "add task to project",
        "add subtask to task",
        "add task dependency",
      ].map((m, i) => c(`bg${i}`, [m], [], 1)),
    ],
    [],
    new VerbLexicon(),
  );
  assert.notEqual(
    tree.parentOf.get("cm"),
    tree.parentOf.get("tg"),
    "commenting is not tagging, whatever one stray member says",
  );
});

/* keyed level 1 (intent frames) */

const KEYED_CATALOG = [
  {
    name: "acme__create_task",
    description: "Create a new task in a project; returns the new task id.",
    inputSchema: { properties: { projectId: {}, title: {} } },
  },
  {
    name: "acme__add_task_comment",
    description: "Add a comment to an existing task.",
    inputSchema: { properties: { taskId: {}, body: {} } },
  },
  {
    name: "acme__list_tasks",
    description: "List the tasks in a project.",
    inputSchema: { properties: { projectId: {} } },
  },
];

async function keyed(level0: LevelInput[], prior: Parameters<typeof buildLevels>[1] = []) {
  const { buildActionContext, memberKey } = await import("@/lib/readings/intent-engine/actions");
  const verbs = new VerbLexicon();
  for (const t of KEYED_CATALOG) verbs.learnTool(t.name);
  const ctx = buildActionContext(KEYED_CATALOG, verbs);
  return buildLevels(level0, prior, verbs, { keyOf: (m) => memberKey(m, ctx) });
}

const PARAPHRASES = [
  c("cr", ["create task", "create a task in project"], ["acme__create_task"], 6),
  c("gv", ["give new task id for it"], [], 2),
  c("ad", ["add a new task"], ["acme__create_task"], 1),
  c("cm", ["add comment to task", "comment on task"], ["acme__add_task_comment"], 4),
  c("ls", ["list tasks in project"], ["acme__list_tasks"], 3),
];

test("keyed level 1 groups paraphrases of one action, whatever their wording", async () => {
  const tree = await keyed(PARAPHRASES);
  const create = tree.parentOf.get("cr");
  assert.equal(tree.parentOf.get("gv"), create, '"give new task id" is creating a task');
  assert.equal(tree.parentOf.get("ad"), create);
  const node = tree.levels[1].find((n) => n.uuid === create)!;
  assert.equal(node.label, "Create task");
});

test("keyed level 1 never joins a comment to creating its task", async () => {
  const tree = await keyed(PARAPHRASES);
  assert.notEqual(tree.parentOf.get("cm"), tree.parentOf.get("cr"));
  assert.notEqual(tree.parentOf.get("ls"), tree.parentOf.get("cr"));
  assert.equal(
    tree.levels[1].find((n) => n.uuid === tree.parentOf.get("cm"))!.label,
    "Create comment",
  );
});

test("keyed level 2 groups by the key's object", async () => {
  const tree = await keyed(PARAPHRASES);
  const topOf = (id: string) => tree.parentOf.get(tree.parentOf.get(id)!);
  assert.equal(topOf("cr"), topOf("ls"), "creating and listing tasks are one domain");
  assert.notEqual(topOf("cr"), topOf("cm"));
});

test("keyed ids are stable across rebuilds", async () => {
  const first = await keyed(PARAPHRASES);
  const prior = first.levels.flatMap((nodes) =>
    nodes.map((n) => ({ uuid: n.uuid, level: n.level, children: n.children })),
  );
  const again = await keyed([...PARAPHRASES, c("mk", ["make a task for the bug"], [], 1)], prior);
  assert.equal(again.parentOf.get("cr"), first.parentOf.get("cr"));
  assert.equal(again.parentOf.get("mk"), first.parentOf.get("cr"));
});

test("a node with no key falls back to wording", async () => {
  const tree = await keyed([...PARAPHRASES, c("wx", ["weather in paris"], [], 1)]);
  assert.ok(tree.parentOf.get("wx"), "still placed at level 1");
  assert.notEqual(tree.parentOf.get("wx"), tree.parentOf.get("cr"));
});

test("the hierarchy stops at level 2 unless a caller asks for more", () => {
  const level0 = [
    c("fb", ["create feedback for acme"], ["feedback__create_feedback"], 3),
    c("cu", ["create customer acme"], ["crm__create_customer"], 3),
    c("cs", ["search customer feedback"], ["crm__search_customers"], 2),
  ];
  assert.equal(buildLevels(level0, [], new VerbLexicon()).levels.length, 3, "levels 0, 1 and 2");
  assert.ok(buildLevels(level0, [], new VerbLexicon(), { maxLevels: 6 }).levels.length >= 3);
});

test("a model key groups clusters the rules cannot, and names the intent and domain from it", async () => {
  const { stem } = await import("@/lib/readings/intent-engine/text");
  const assignChecklist = { action: stem("assign"), object: stem("checklist") };
  const createTask = { action: stem("create"), object: stem("task") };
  const level0: LevelInput[] = [
    {
      ...c("ada", ["give Ada the Falcon onboarding checklist"], ["assign_task"], 3),
      llmKey: assignChecklist,
    },
    {
      ...c("chen", ["give Chen the Falcon onboarding checklist"], ["assign_task"], 2),
      llmKey: assignChecklist,
    },
    // No model key: the rules' key still applies.
    c("mk", ["create task"], ["create_task"], 4),
  ];
  const tree = buildLevels(level0, [], new VerbLexicon(), {
    keyOf: (m) => (m.startsWith("create") ? createTask : null),
  });
  assert.equal(
    tree.parentOf.get("ada"),
    tree.parentOf.get("chen"),
    '"give" is no verb the rules know; the model\'s key joins them',
  );
  assert.notEqual(tree.parentOf.get("ada"), tree.parentOf.get("mk"));
  const intent = tree.levels[1].find((n) => n.uuid === tree.parentOf.get("ada"))!;
  assert.equal(intent.label, "Assign checklist");
  const domain = tree.levels[2].find((n) => n.uuid === tree.parentOf.get(intent.uuid))!;
  assert.match(domain.label, /checklist/i);
  assert.notEqual(
    tree.parentOf.get(intent.uuid),
    tree.parentOf.get(tree.parentOf.get("mk")!),
    "tasks are another domain",
  );
});
