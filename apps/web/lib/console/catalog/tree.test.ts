import assert from "node:assert/strict";
import { test } from "node:test";
import {
  observedTool,
  runtimeDefinition,
  skillItems,
  skillRecord,
  syncedTool,
  toolItems,
} from "./test-support";
import {
  buildCatalogTree,
  type CatalogTreeEntry,
  type CatalogTreeNode,
  catalogTreeEntry,
  filterCatalogTree,
  initialExpanded,
  integrationOf,
  mcpServerOf,
  namePrefixOf,
  searchExpanded,
  toolGroupLabels,
  treeItemKeys,
} from "./tree";

const DEMO_TOOLS = [
  "calendar_create_event",
  "calendar_list_events",
  "confluence_search",
  "github_api",
  "kanban_create_task",
  "kanban_update_task",
  "kanban_whoami",
  "ripgrep",
  "s3_get_object",
  "s3_put_object",
  "test_runner",
];

function demoTools() {
  return toolItems({
    observed: [
      observedTool("kanban_whoami", 3),
      observedTool("lookup_order", 45),
      observedTool("search_docs", 15),
    ],
    definitions: DEMO_TOOLS.map((name) => runtimeDefinition(name)),
  });
}

function shape(nodes: readonly CatalogTreeNode[]): unknown[] {
  return nodes.map((node) =>
    node.kind === "item"
      ? node.label
      : { [`${node.label} (${node.count})`]: shape(node.children ?? []) },
  );
}

test("MCP servers and name prefixes read as integrations; the rest is Other", () => {
  assert.equal(mcpServerOf("github__create_issue"), "github");
  assert.equal(mcpServerOf("__weird"), null);
  assert.equal(mcpServerOf("plain_name"), null);
  assert.equal(namePrefixOf("kanban_create_task"), "kanban");
  assert.equal(namePrefixOf("slack.post_message"), "slack");
  assert.equal(namePrefixOf("s3_get_object"), "s3");
  assert.equal(namePrefixOf("get_user"), null, "a verb is not an integration");
  assert.equal(namePrefixOf("ripgrep"), null);
  assert.equal(namePrefixOf("x_y"), null, "one letter is not a namespace");
});

test("the demo catalog groups by integration, with Other and Observed only last", () => {
  const tree = buildCatalogTree(demoTools().map(catalogTreeEntry));
  assert.deepEqual(shape(tree), [
    {
      "Tools (13)": [
        { "calendar (2)": ["calendar_create_event", "calendar_list_events"] },
        { "kanban (3)": ["kanban_create_task", "kanban_update_task", "kanban_whoami"] },
        { "s3 (2)": ["s3_get_object", "s3_put_object"] },
        { "Other (4)": ["confluence_search", "github_api", "ripgrep", "test_runner"] },
        { "Observed only (2)": ["lookup_order", "search_docs"] },
      ],
    },
    { "Skills (0)": [] },
  ]);
});

test("an item node carries its key and its usage count", () => {
  const tree = buildCatalogTree(demoTools().map(catalogTreeEntry));
  const kanban = tree[0].children?.find((node) => node.label === "kanban");
  const whoami = kanban?.children?.find((node) => node.label === "kanban_whoami");
  assert.deepEqual(whoami && { id: whoami.id, itemKey: whoami.itemKey, count: whoami.count }, {
    id: "tool:kanban_whoami",
    itemKey: "tool:kanban_whoami",
    count: 3,
  });
});

test("MCP server names win over prefixes, and sources group only when there is more than one", () => {
  const entry = (name: string, source: string | null = null): CatalogTreeEntry => ({
    key: `tool:${name}`,
    kind: "tool",
    name,
    ids: [name],
    provenance: "managed",
    status: null,
    count: 0,
    source,
    sourceFresh: source !== null,
    searchText: name,
  });
  const single = toolGroupLabels([
    entry("github__create_issue"),
    entry("github__merge"),
    entry("create_ticket", "worker-a"),
    entry("close_ticket", "worker-a"),
  ]);
  assert.equal(single.get("tool:github__create_issue"), "github");
  assert.equal(
    single.get("tool:create_ticket"),
    "Other",
    "one source says nothing about where a tool comes from",
  );
  const many = toolGroupLabels([
    entry("create_ticket", "support-bot"),
    entry("search_code", "coding-agent"),
    entry("kanban_a"),
    entry("kanban_b"),
  ]);
  assert.equal(many.get("tool:create_ticket"), "support-bot");
  assert.equal(many.get("tool:search_code"), "coding-agent");
  assert.equal(many.get("tool:kanban_a"), "kanban", "unsynced tools still group by prefix");
});

test("MCP servers come from the registered id, not the bare name the SDK keeps", () => {
  // The SDK registers `<server>__<tool>` as the id and keeps `name` bare.
  const items = toolItems({
    synced: [
      syncedTool("create_issue", "app", { toolId: "github__create_issue" }),
      syncedTool("merge_pr", "app", { toolId: "github__merge_pr" }),
      syncedTool("post_message", "app", { toolId: "slack__post_message" }),
    ],
    definitions: [
      runtimeDefinition("create_issue", { entryId: "github__create_issue" }),
      runtimeDefinition("merge_pr", { entryId: "github__merge_pr" }),
      runtimeDefinition("post_message", { entryId: "slack__post_message" }),
    ],
  });
  assert.deepEqual(shape(buildCatalogTree(items.map(catalogTreeEntry)))[0], {
    "Tools (3)": [
      { "github (2)": ["create_issue", "merge_pr"] },
      { "slack (1)": ["post_message"] },
    ],
  });
});

test("a leftover stale source does not regroup everything by source", () => {
  const items = toolItems({
    synced: [
      syncedTool("kanban_a", "app-v2"),
      syncedTool("kanban_b", "app-v2"),
      syncedTool("slack_post", "app-v2"),
      syncedTool("slack_list", "app-v2"),
      syncedTool("kanban_old", "app-v1", { sourceStatus: "stale" }),
    ],
    definitions: ["kanban_a", "kanban_b", "slack_post", "slack_list", "kanban_old"].map((name) =>
      runtimeDefinition(name),
    ),
  });
  assert.deepEqual(shape(buildCatalogTree(items.map(catalogTreeEntry)))[0], {
    "Tools (5)": [
      { "kanban (3)": ["kanban_a", "kanban_b", "kanban_old"] },
      { "slack (2)": ["slack_list", "slack_post"] },
    ],
  });
});

test("function words never become groups, and prefixes ignore case", () => {
  const labels = toolGroupLabels(
    ["is_admin", "is_member", "has_access", "has_role", "Slack_post", "slack_list"].map((name) => ({
      key: `tool:${name}`,
      kind: "tool" as const,
      name,
      ids: [name],
      provenance: "managed" as const,
      status: null,
      count: 0,
      source: null,
      sourceFresh: false,
      searchText: name,
    })),
  );
  assert.equal(labels.get("tool:is_admin"), "Other");
  assert.equal(labels.get("tool:has_role"), "Other");
  assert.equal(labels.get("tool:Slack_post"), "slack");
  assert.equal(labels.get("tool:slack_list"), "slack");
});

test("tools synced from two runtimes group by runtime", () => {
  const items = toolItems({
    synced: [
      syncedTool("create_ticket", "support-bot"),
      syncedTool("search_code", "coding-agent"),
      syncedTool("read_file", "coding-agent"),
    ],
    definitions: ["create_ticket", "search_code", "read_file"].map((name) =>
      runtimeDefinition(name),
    ),
  });
  assert.deepEqual(shape(buildCatalogTree(items.map(catalogTreeEntry)))[0], {
    "Tools (3)": [
      { "coding-agent (2)": ["read_file", "search_code"] },
      { "support-bot (1)": ["create_ticket"] },
    ],
  });
});

test("one group holding every registered tool is no group", () => {
  const items = toolItems({
    observed: [observedTool("legacy_export", 1)],
    definitions: ["kanban_a", "kanban_b", "kanban_c"].map((name) => runtimeDefinition(name)),
  });
  assert.deepEqual(shape(buildCatalogTree(items.map(catalogTreeEntry)))[0], {
    "Tools (4)": ["kanban_a", "kanban_b", "kanban_c", { "Observed only (1)": ["legacy_export"] }],
  });
});

test("group ids never collide, whatever a prefix is called", () => {
  const items = toolItems({
    definitions: ["other_a", "other_b", "observed_a", "observed_b", "ripgrep"].map((name) =>
      runtimeDefinition(name),
    ),
  });
  const ids = buildCatalogTree(items.map(catalogTreeEntry))[0].children?.map((node) => node.id);
  assert.deepEqual(ids, [
    "group:tool:named:observed",
    "group:tool:named:other",
    "group:tool:other",
  ]);
});

test("skills group by status, then runtime, then observed", () => {
  const items = skillItems({
    skills: [
      skillRecord("b-skill"),
      skillRecord("a-skill"),
      skillRecord("draft-skill", { status: "draft" }),
      skillRecord("old", { status: "archived" }),
    ],
    runtimeSkills: [
      runtimeDefinition("runtime-skill"),
      { entryId: null, name: "seen-skill", provenance: "observed", lastSeenAt: new Date() },
    ],
  });
  assert.deepEqual(shape(buildCatalogTree(items.map(catalogTreeEntry)))[1], {
    "Skills (6)": [
      { "Published (2)": ["a-skill", "b-skill"] },
      { "Drafts (1)": ["draft-skill"] },
      { "Archived (1)": ["old"] },
      { "From your runtime (1)": ["runtime-skill"] },
      { "Observed only (1)": ["seen-skill"] },
    ],
  });
});

test("search keeps matching items by name or description, and a matching group whole", () => {
  const tools = toolItems({
    definitions: [
      runtimeDefinition("kanban_create_task", { description: "Create a task in a project." }),
      runtimeDefinition("kanban_whoami", { description: "Return the caller's identity." }),
      runtimeDefinition("payments_refund_charge", { description: "Refund a charge." }),
      runtimeDefinition("payments_get_customer", { description: "Fetch one customer." }),
    ],
  });
  const skills = skillItems({
    skills: [skillRecord("review-pull-request", { description: "Review a pull request." })],
  });
  const tree = buildCatalogTree([...tools, ...skills].map(catalogTreeEntry));

  assert.deepEqual(shape(filterCatalogTree(tree, "refund")), [
    { "Tools (1)": [{ "payments (1)": ["payments_refund_charge"] }] },
  ]);
  assert.deepEqual(
    shape(filterCatalogTree(tree, "  TASK ")),
    [{ "Tools (1)": [{ "kanban (1)": ["kanban_create_task"] }] }],
    "trimmed, any case",
  );
  assert.deepEqual(shape(filterCatalogTree(tree, "payments")), [
    { "Tools (2)": [{ "payments (2)": ["payments_get_customer", "payments_refund_charge"] }] },
  ]);
  assert.deepEqual(shape(filterCatalogTree(tree, "pull request")), [
    { "Skills (1)": [{ "Published (1)": ["review-pull-request"] }] },
  ]);
  assert.deepEqual(filterCatalogTree(tree, "nothing like this"), []);
  assert.deepEqual(filterCatalogTree(tree, ""), tree);
  assert.deepEqual(filterCatalogTree(tree, "   "), tree, "a blank query is no query");
});

test("both roots and a root's only group start open, plus the path to the selection", () => {
  const items = [
    ...toolItems({
      definitions: ["kanban_a", "kanban_b", "slack_a", "slack_b"].map((name) =>
        runtimeDefinition(name),
      ),
    }),
    ...skillItems({ skills: [skillRecord("deploy-service")] }),
  ];
  const tree = buildCatalogTree(items.map(catalogTreeEntry));
  assert.deepEqual([...initialExpanded(tree, null)].sort(), [
    "group:skill:published",
    "root:skill",
    "root:tool",
  ]);
  assert.deepEqual([...initialExpanded(tree, "tool:slack_b")].sort(), [
    "group:skill:published",
    "group:tool:named:slack",
    "root:skill",
    "root:tool",
  ]);
  assert.deepEqual([...initialExpanded(tree, "tool:missing")].sort(), [
    "group:skill:published",
    "root:skill",
    "root:tool",
  ]);
});

test("only an integration group names where an item comes from", () => {
  const tree = buildCatalogTree(
    [...demoTools(), ...skillItems({ skills: [skillRecord("deploy-service")] })].map(
      catalogTreeEntry,
    ),
  );
  assert.equal(integrationOf(tree, "tool:kanban_whoami"), "kanban");
  assert.equal(integrationOf(tree, "tool:ripgrep"), null, "Other is not an integration");
  assert.equal(integrationOf(tree, "tool:lookup_order"), null, "nor is Observed only");
  assert.equal(integrationOf(tree, "skill:id-deploy-service"), null, "a status is not a source");
  assert.equal(integrationOf(tree, "tool:missing"), null);
});

test("a search opens every branch with a match unless the reader closed it", () => {
  const tree = buildCatalogTree(
    toolItems({
      definitions: ["kanban_a", "kanban_b", "slack_a", "slack_b"].map((name) =>
        runtimeDefinition(name),
      ),
    }).map(catalogTreeEntry),
  );
  const filtered = filterCatalogTree(tree, "_a");
  assert.deepEqual(
    [...searchExpanded(filtered, new Set())],
    ["root:tool", "group:tool:named:kanban", "group:tool:named:slack"],
  );
  assert.deepEqual(
    [...searchExpanded(filtered, new Set(["group:tool:named:slack"]))],
    ["root:tool", "group:tool:named:kanban"],
  );
  assert.deepEqual(treeItemKeys(filtered), ["tool:kanban_a", "tool:slack_a"]);
});
