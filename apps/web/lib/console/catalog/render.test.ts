// The runner only picks up `.ts`, so components are built with createElement.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CatalogItemDetail,
  type CatalogItemDetailProps,
} from "@/components/console/catalog/CatalogItemDetail";
import { CatalogTree } from "@/components/console/catalog/CatalogTree";
import {
  NOW,
  observedTool,
  runtimeDefinition,
  skillItems,
  skillRecord,
  toolItems,
} from "./test-support";
import { buildCatalogTree, catalogTreeEntry, initialExpanded } from "./tree";

const tools = toolItems({
  observed: [observedTool("ripgrep", 73), observedTool("lookup_order", 45)],
  definitions: [
    runtimeDefinition("ripgrep", {
      description: "Search a working tree for a regular expression.",
      searchableDescription: "grep the codebase, find where something is defined",
      searchableDescriptionOverridden: true,
    }),
    runtimeDefinition("kanban_create_task"),
    runtimeDefinition("kanban_update_task"),
    runtimeDefinition("slack_post_message"),
    runtimeDefinition("slack_add_reaction"),
    runtimeDefinition("test_runner"),
  ],
});
const skills = skillItems({
  skills: [skillRecord("review-pull-request", { tags: ["git"], tools: ["github_api"] })],
});
const tree = buildCatalogTree([...tools, ...skills].map(catalogTreeEntry));

function renderTree(selectedKey: string | null, expanded = initialExpanded(tree, selectedKey)) {
  return renderToStaticMarkup(
    createElement(CatalogTree, {
      nodes: tree,
      expanded,
      onExpandedChange: () => undefined,
      selectedKey,
      onSelect: () => undefined,
    }),
  );
}

/** The opening tag of the tree row for `id`. */
function row(html: string, id: string): string {
  const match = new RegExp(
    `<div[^>]*data-tree-id="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`,
  ).exec(html);
  assert.ok(match, `row ${id} is rendered`);
  return match[0];
}

test("the catalog is a named WAI-ARIA tree with one row per visible node", () => {
  const html = renderTree("tool:ripgrep");
  assert.match(html, /^<div role="tree" aria-label="Catalog items"/);
  // Tools, kanban, slack, Other with ripgrep and test_runner (open: it holds the selection),
  // Observed only, Skills, Published, review-pull-request.
  assert.equal(html.match(/role="treeitem"/g)?.length, 10);
});

test("parents say whether they are open; leaves do not", () => {
  const html = renderTree("tool:ripgrep");
  assert.match(row(html, "root:tool"), /aria-expanded="true"/);
  assert.match(row(html, "group:tool:named:kanban"), /aria-expanded="false"/);
  assert.match(
    row(html, "group:tool:other"),
    /aria-expanded="true"/,
    "the selection's group starts open",
  );
  assert.doesNotMatch(row(html, "tool:ripgrep"), /aria-expanded/);
});

test("only the selected leaf is selected, and it holds the one tab stop", () => {
  const html = renderTree("tool:ripgrep");
  assert.equal(html.match(/aria-selected="true"/g)?.length, 1);
  assert.match(row(html, "tool:ripgrep"), /aria-selected="true"/);
  assert.equal(html.match(/tabindex="0"/g)?.length, 1, "roving tabindex: one row in the tab order");
  assert.match(row(html, "tool:ripgrep"), /tabindex="0"/);
  assert.match(row(html, "root:tool"), /tabindex="-1"/);
});

test("with nothing selected the first row holds the tab stop and nothing is selected", () => {
  const html = renderTree(null);
  assert.doesNotMatch(html, /aria-selected/);
  assert.match(row(html, "root:tool"), /tabindex="0"/);
});

test("each row carries its level, size and position, and says what its count means", () => {
  const html = renderTree("tool:ripgrep");
  const ripgrep = row(html, "tool:ripgrep");
  assert.match(ripgrep, /aria-level="3"/);
  assert.match(ripgrep, /aria-setsize="2"/, "Other holds ripgrep and test_runner");
  assert.match(ripgrep, /aria-posinset="1"/);
  assert.match(row(html, "tool:test_runner"), /aria-posinset="2"/);
  assert.match(html, /<span class="sr-only">, 73 calls<\/span>/);
  assert.match(html, /<span class="sr-only">, 7 tools<\/span>/, "a root counts its items");
});

const ripgrep = tools.find((item) => item.name === "ripgrep")!;
const lookup = tools.find((item) => item.name === "lookup_order")!;
const detail = (props: Partial<CatalogItemDetailProps> & Pick<CatalogItemDetailProps, "item">) =>
  renderToStaticMarkup(
    createElement(CatalogItemDetail, {
      now: NOW,
      layout: "pane",
      onSaveSearchable: async () => null,
      onResetSearchable: async () => null,
      ...props,
    }),
  );

test("a managed tool shows its searchable description with Edit, and its agent description read only", () => {
  const html = detail({ item: ripgrep, groupLabel: "code" });
  assert.match(html, /<article[^>]*data-catalog-item="tool:ripgrep"/);
  assert.match(html, /<h2[^>]*>ripgrep<\/h2>/);
  assert.match(html, /Tool in code · Synced from your runtime\./);
  assert.match(html, /data-field="searchable-description"/);
  assert.match(html, /grep the codebase, find where something is defined/);
  assert.match(html, /From your runtime\./);
  assert.match(html, /aria-label="Edit searchable description"/);
  assert.match(
    html,
    /data-field="agent-description"[\s\S]*Search a working tree for a regular expression\./,
  );
  assert.match(html, /Read only\./);
});

test("usage is a stat row and the definition starts closed", () => {
  const html = detail({ item: ripgrep });
  assert.match(html, /<dl/);
  assert.match(html, /Calls<\/dt>[\s\S]*73/);
  assert.match(html, /Estimated from traces/);
  assert.match(html, /Last seen<\/dt>[\s\S]*Oct 9, 2026/);
  assert.match(
    html,
    /5\u00a0days ago/,
    "the hint is relative while it says something the day does not",
  );
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>[\s\S]*Definition<\/button>/);
  assert.match(html, /role="region"[^>]*hidden=""/);
});

test("without the override flag a managed tool is read only", () => {
  const [readOnly] = toolItems({ definitions: [runtimeDefinition("ripgrep")], editable: false });
  const html = detail({ item: readOnly });
  assert.match(html, /data-field="searchable-description"/);
  assert.doesNotMatch(html, /Edit searchable description/);
  assert.match(html, /Same text as the searchable description\./, "one text is said once");
});

test("an observed tool explains why there is nothing to edit", () => {
  const html = detail({ item: lookup });
  assert.doesNotMatch(html, /data-field="searchable-description"/);
  assert.doesNotMatch(html, /Edit searchable description/);
  assert.match(html, /role="note"[^>]*>[\s\S]*Seen in traces only/);
  assert.match(html, /Observed/);
  assert.doesNotMatch(html, /aria-expanded/, "no definition to disclose");
});

test("a Ratel copy the runtime has not confirmed says so", () => {
  const [copied] = toolItems({
    definitions: [runtimeDefinition("ripgrep", { searchableDescriptionOverride: "grep files" })],
  });
  const html = detail({ item: copied, adopted: { tool: null, skill: null } });
  assert.match(html, /Set here in Ratel\./);
  assert.match(html, /Your runtime may still be using its own copy\./);
  assert.doesNotMatch(
    detail({ item: copied, adopted: { tool: true, skill: null } }),
    /its own copy/,
  );
});

test("a Ratel skill shows its status, runs and instructions; in a Panel the Panel names it", () => {
  const [skill] = skills;
  const html = detail({ item: skill });
  assert.match(html, /Published/);
  assert.match(html, /Runs<\/dt>/);
  assert.match(html, /Instructions<\/button>/);
  assert.doesNotMatch(html, /Read only\./, "Ratel owns a Ratel skill's description");
  const panel = detail({ item: skill, layout: "panel" });
  assert.doesNotMatch(panel, /<h2/, "the Panel's title is the heading");
  assert.match(panel, /Created here in Ratel\./);
});
