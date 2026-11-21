import { expandableIds, type TreeModelNode, treePath } from "@ratel/design-system/tree-model";
import type { CatalogItem, CatalogProvenance, SkillStatus } from "./items";

/**
 * The Catalog home's tree: Tools and Skills at the root, each grouped the way
 * its data reads most naturally, then every item. Pure, so the grouping rules
 * are pinned by tests rather than by screenshots.
 *
 * Tools group by where they come from, most specific signal first:
 *   1. the MCP server, from the `<server>__<tool>` names the Ratel SDK gives
 *      every tool it ingests from one (`registerMcpServer`);
 *   2. the runtime source that syncs it, but only when the tools really come
 *      from more than one (a project with one live source would get a single
 *      group holding everything);
 *   3. a shared name prefix (`kanban_*`, `slack.*`), when two or more tools
 *      share it and it is not a verb like `get_` or `list_`;
 *   4. "Other".
 * Tools seen in traces but never registered sit apart in "Observed only".
 * When everything registered lands in one group, the group adds nothing and
 * its tools sit directly under Tools.
 *
 * Skills group by status (Published, Drafts, Archived), then the ones a
 * runtime registered, then the ones only seen in traces.
 */

export type CatalogTreeNodeKind = "root" | "group" | "item";

export interface CatalogTreeNode extends TreeModelNode {
  kind: CatalogTreeNodeKind;
  /** For a root or a group, the items under it; for an item, its calls or runs. */
  count: number;
  /** The item key (`tool:<name>`), on item nodes. */
  itemKey?: string;
  /** Lowercased name and descriptions, on item nodes: what the search box matches. */
  searchText?: string;
  children?: CatalogTreeNode[];
}

/** What the tree needs to know about an item. */
export interface CatalogTreeEntry {
  key: string;
  kind: "tool" | "skill";
  name: string;
  /** The ids the runtime registered it under (tools); MCP server ids live here, not in the name. */
  ids: readonly string[];
  provenance: CatalogProvenance;
  status: SkillStatus | null;
  count: number;
  source: string | null;
  /** Whether `source` still publishes; only fresh sources decide the grouping. */
  sourceFresh: boolean;
  searchText: string;
}

export const TOOLS_ROOT = "root:tool";
export const SKILLS_ROOT = "root:skill";
export const OTHER_LABEL = "Other";
export const OBSERVED_LABEL = "Observed only";
export const RUNTIME_SKILLS_LABEL = "From your runtime";
/** Integration groups get their own id namespace, apart from the fixed "Other" and "Observed only". */
const NAMED_TOOL_GROUP = "group:tool:named:";

const STATUS_GROUPS: readonly { status: SkillStatus; label: string }[] = [
  { status: "published", label: "Published" },
  { status: "draft", label: "Drafts" },
  { status: "archived", label: "Archived" },
];

/**
 * Prefixes that name what a tool does rather than where it comes from.
 * `get_user` and `get_order` share a verb, not an integration; `is_admin`
 * and `has_access` share a function word.
 */
const FUNCTION_WORDS = new Set([
  "a",
  "all",
  "an",
  "and",
  "any",
  "as",
  "at",
  "by",
  "can",
  "did",
  "does",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "is",
  "it",
  "its",
  "my",
  "new",
  "no",
  "not",
  "of",
  "off",
  "on",
  "or",
  "our",
  "should",
  "the",
  "to",
  "up",
  "was",
  "with",
  "your",
]);

const VERB_PREFIXES = new Set([
  "add",
  "append",
  "approve",
  "archive",
  "assign",
  "book",
  "build",
  "calculate",
  "call",
  "cancel",
  "charge",
  "check",
  "claim",
  "clear",
  "close",
  "complete",
  "compute",
  "convert",
  "copy",
  "create",
  "delete",
  "deploy",
  "describe",
  "do",
  "download",
  "edit",
  "execute",
  "explain",
  "export",
  "extract",
  "fetch",
  "filter",
  "find",
  "format",
  "generate",
  "get",
  "handle",
  "import",
  "invite",
  "invoke",
  "link",
  "list",
  "load",
  "lookup",
  "make",
  "mark",
  "merge",
  "move",
  "mute",
  "notify",
  "open",
  "parse",
  "pay",
  "ping",
  "post",
  "process",
  "promote",
  "publish",
  "put",
  "query",
  "read",
  "refresh",
  "refund",
  "register",
  "reject",
  "remove",
  "render",
  "reset",
  "resolve",
  "retry",
  "rollback",
  "run",
  "save",
  "scan",
  "schedule",
  "search",
  "send",
  "set",
  "show",
  "start",
  "stop",
  "submit",
  "summarize",
  "sync",
  "test",
  "track",
  "transfer",
  "translate",
  "trigger",
  "unlink",
  "unregister",
  "update",
  "upload",
  "validate",
  "verify",
  "view",
  "write",
]);

/** The MCP server a tool was ingested from, from the SDK's `<server>__<tool>` id. */
export function mcpServerOf(name: string): string | null {
  const separator = name.indexOf("__");
  if (separator <= 0 || separator + 2 >= name.length) return null;
  return name.slice(0, separator);
}

/** The namespace-like prefix of a tool name (`kanban` in `kanban_create_task`), or null. */
export function namePrefixOf(name: string): string | null {
  const match = /^([A-Za-z0-9]+)[_.\-/:](?=[A-Za-z0-9])/.exec(name);
  if (!match) return null;
  // Lowercased, so `Slack_post` and `slack_list` land in one group.
  const prefix = match[1].toLowerCase();
  if (prefix.length < 2 || VERB_PREFIXES.has(prefix) || FUNCTION_WORDS.has(prefix)) return null;
  return prefix;
}

/** The fields the tree reads from an item. */
export function catalogTreeEntry(item: CatalogItem): CatalogTreeEntry {
  return {
    key: item.key,
    kind: item.kind,
    name: item.name,
    ids: item.kind === "tool" ? item.ids : [],
    provenance: item.provenance,
    status: item.kind === "skill" ? item.status : null,
    count: item.kind === "tool" ? item.calls : item.runs,
    source: item.kind === "tool" ? item.source : null,
    sourceFresh: item.kind === "tool" ? item.sourceFresh : false,
    searchText: [item.name, item.searchable?.text, item.agentDescription]
      .filter(Boolean)
      .join("\n")
      .toLowerCase(),
  };
}

/** The group each registered tool belongs to, by the rules above. Observed tools are not in the map. */
export function toolGroupLabels(entries: readonly CatalogTreeEntry[]): Map<string, string> {
  const registered = entries.filter(
    (entry) => entry.kind === "tool" && entry.provenance !== "observed",
  );
  const labels = new Map<string, string>();
  const remaining: CatalogTreeEntry[] = [];
  for (const entry of registered) {
    const server =
      mcpServerOf(entry.name) ?? entry.ids.map(mcpServerOf).find((id) => id !== null) ?? null;
    if (server) labels.set(entry.key, server);
    else remaining.push(entry);
  }

  // Only sources still publishing count: a tool left behind by a retired
  // source (kept up to 30 days) must not regroup everything by source id.
  const fresh = remaining.filter((entry) => entry.sourceFresh && entry.source !== null);
  const bySource = new Set(fresh.map((entry) => entry.source)).size > 1;
  const unsourced: CatalogTreeEntry[] = [];
  for (const entry of remaining) {
    if (bySource && entry.sourceFresh && entry.source) labels.set(entry.key, entry.source);
    else unsourced.push(entry);
  }

  const prefixCounts = new Map<string, number>();
  for (const entry of unsourced) {
    const prefix = namePrefixOf(entry.name);
    if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  for (const entry of unsourced) {
    const prefix = namePrefixOf(entry.name);
    labels.set(entry.key, prefix && (prefixCounts.get(prefix) ?? 0) >= 2 ? prefix : OTHER_LABEL);
  }
  return labels;
}

function byName(a: { label: string }, b: { label: string }): number {
  return (
    a.label.localeCompare(b.label, "en", { sensitivity: "base" }) || a.label.localeCompare(b.label)
  );
}

function itemNode(entry: CatalogTreeEntry): CatalogTreeNode {
  return {
    id: entry.key,
    label: entry.name,
    kind: "item",
    count: entry.count,
    itemKey: entry.key,
    searchText: entry.searchText,
  };
}

function groupNode(
  id: string,
  label: string,
  entries: readonly CatalogTreeEntry[],
): CatalogTreeNode {
  const children = entries.map(itemNode).sort(byName);
  return { id, label, kind: "group", count: children.length, children };
}

function toolChildren(entries: readonly CatalogTreeEntry[]): CatalogTreeNode[] {
  const labels = toolGroupLabels(entries);
  const grouped = new Map<string, CatalogTreeEntry[]>();
  for (const entry of entries) {
    const label = labels.get(entry.key);
    if (label === undefined) continue;
    grouped.set(label, [...(grouped.get(label) ?? []), entry]);
  }
  const observed = entries.filter((entry) => entry.provenance === "observed");
  const observedGroup =
    observed.length > 0 ? [groupNode("group:tool:observed", OBSERVED_LABEL, observed)] : [];

  // One group holding every registered tool says nothing; list them directly.
  if (grouped.size <= 1) {
    const only = [...grouped.values()][0] ?? [];
    return [...only.map(itemNode).sort(byName), ...observedGroup];
  }
  // A `kanban_*` prefix can never collide with the fixed ids, whatever it is called.
  const named = [...grouped.entries()]
    .filter(([label]) => label !== OTHER_LABEL)
    .map(([label, members]) => groupNode(`${NAMED_TOOL_GROUP}${label}`, label, members))
    .sort(byName);
  const other = grouped.get(OTHER_LABEL);
  return [
    ...named,
    ...(other ? [groupNode("group:tool:other", OTHER_LABEL, other)] : []),
    ...observedGroup,
  ];
}

function skillChildren(entries: readonly CatalogTreeEntry[]): CatalogTreeNode[] {
  const groups: CatalogTreeNode[] = [];
  for (const { status, label } of STATUS_GROUPS) {
    const members = entries.filter(
      (entry) => entry.provenance === "cloud" && entry.status === status,
    );
    if (members.length > 0) groups.push(groupNode(`group:skill:${status}`, label, members));
  }
  const runtime = entries.filter((entry) => entry.provenance === "managed");
  if (runtime.length > 0)
    groups.push(groupNode("group:skill:runtime", RUNTIME_SKILLS_LABEL, runtime));
  const observed = entries.filter((entry) => entry.provenance === "observed");
  if (observed.length > 0) groups.push(groupNode("group:skill:observed", OBSERVED_LABEL, observed));
  return groups;
}

/** Tools and Skills, always both, so an empty side still says it is empty. */
export function buildCatalogTree(entries: readonly CatalogTreeEntry[]): CatalogTreeNode[] {
  const tools = entries.filter((entry) => entry.kind === "tool");
  const skills = entries.filter((entry) => entry.kind === "skill");
  return [
    {
      id: TOOLS_ROOT,
      label: "Tools",
      kind: "root",
      count: tools.length,
      children: toolChildren(tools),
    },
    {
      id: SKILLS_ROOT,
      label: "Skills",
      kind: "root",
      count: skills.length,
      children: skillChildren(skills),
    },
  ];
}

/**
 * The tree narrowed to what matches the search: an item matches on its name
 * or descriptions, a group on its own label (and keeps all of its items).
 * Counts become match counts and empty branches drop out. An empty query
 * returns the tree as it is.
 */
export function filterCatalogTree(
  nodes: readonly CatalogTreeNode[],
  query: string,
): CatalogTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...nodes];
  const prune = (node: CatalogTreeNode): CatalogTreeNode | null => {
    if (node.kind === "item") return node.searchText?.includes(needle) ? node : null;
    if (node.kind === "group" && node.label.toLowerCase().includes(needle)) return node;
    const children = (node.children ?? [])
      .map(prune)
      .filter((child): child is CatalogTreeNode => child !== null);
    if (children.length === 0) return null;
    return { ...node, children, count: countItems(children) };
  };
  return nodes.map(prune).filter((node): node is CatalogTreeNode => node !== null);
}

function countItems(nodes: readonly CatalogTreeNode[]): number {
  return nodes.reduce(
    (sum, node) => sum + (node.kind === "item" ? 1 : countItems(node.children ?? [])),
    0,
  );
}

/**
 * The integration a tool sits under (its MCP server, runtime source or name
 * prefix), or null. "Other", "Observed only" and a skill's status say nothing
 * about where an item comes from, so they are not one.
 */
export function integrationOf(nodes: readonly CatalogTreeNode[], key: string): string | null {
  const group = (treePath(nodes, key) ?? []).find((id) => id.startsWith(NAMED_TOOL_GROUP));
  return group ? group.slice(NAMED_TOOL_GROUP.length) : null;
}

/** Every item key in the tree, in display order. */
export function treeItemKeys(nodes: readonly CatalogTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "item" && node.itemKey ? [node.itemKey] : treeItemKeys(node.children ?? []),
  );
}

/**
 * What starts open: both roots, a group that is its root's only one, and the
 * path down to the selected item, so a shared link shows where it points.
 */
export function initialExpanded(
  nodes: readonly CatalogTreeNode[],
  selectedKey: string | null,
): Set<string> {
  const open = new Set<string>();
  for (const root of nodes) {
    open.add(root.id);
    const groups = (root.children ?? []).filter((child) => child.kind === "group");
    if (groups.length === 1 && (root.children ?? []).length === 1) open.add(groups[0].id);
  }
  if (selectedKey) for (const id of treePath(nodes, selectedKey) ?? []) open.add(id);
  return open;
}

/** While searching, every branch with a match is open unless the reader closed it. */
export function searchExpanded(
  nodes: readonly CatalogTreeNode[],
  closed: ReadonlySet<string>,
): Set<string> {
  return new Set(expandableIds(nodes).filter((id) => !closed.has(id)));
}
