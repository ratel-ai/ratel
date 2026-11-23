/**
 * What kind of thing a tool does, read from its name: the first known verb
 * among its tokens. Pure. A name with no known verb has no class, and a rule
 * that compares classes never fires on it.
 */

export type ActionClass = "read" | "create" | "change" | "remove";

const VERBS: ReadonlyArray<[ActionClass, readonly string[]]> = [
  [
    "read",
    [
      "get",
      "list",
      "find",
      "search",
      "lookup",
      "filter",
      "query",
      "check",
      "read",
      "fetch",
      "show",
      "view",
      "count",
      "describe",
      "retrieve",
      "load",
    ],
  ],
  [
    "create",
    [
      "create",
      "add",
      "post",
      "send",
      "new",
      "insert",
      "make",
      "generate",
      "upload",
      "notify",
      "invite",
      "publish",
      "write",
    ],
  ],
  [
    "change",
    [
      "update",
      "set",
      "edit",
      "modify",
      "change",
      "patch",
      "move",
      "rename",
      "assign",
      "link",
      "mark",
      "sync",
      "merge",
      "restore",
      "complete",
      "close",
      "reopen",
      "manage",
    ],
  ],
  ["remove", ["delete", "remove", "archive", "unlink", "cancel", "revoke", "clear", "drop"]],
];
const CLASS_OF = new Map(
  VERBS.flatMap(([actionClass, verbs]) => verbs.map((verb) => [verb, actionClass] as const)),
);

/** Tools that probe by criteria: finding nothing is an answer, not a wrong reference. */
const PROBES: ReadonlySet<string> = new Set(["search", "list", "filter", "find", "query", "count"]);

/**
 * A tool id as it is compared: without a namespace prefix (`server__tool`,
 * `server.tool`, `server/tool`, `skill:id`), lowercased.
 */
export function toolName(id: string): string {
  const last =
    id
      .split(/__|[./:]/)
      .filter(Boolean)
      .at(-1) ?? id;
  return last.trim().toLowerCase();
}

const tokensOf = (id: string): string[] =>
  toolName(id.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const firstVerb = (id: string): string | null =>
  tokensOf(id).find((token) => CLASS_OF.has(token)) ?? null;

export function actionClassOf(id: string): ActionClass | null {
  const verb = firstVerb(id);
  return verb === null ? null : (CLASS_OF.get(verb) ?? null);
}

/** A tool that searches, lists or filters. */
export function isProbe(id: string): boolean {
  const verb = firstVerb(id);
  return verb !== null && PROBES.has(verb);
}
