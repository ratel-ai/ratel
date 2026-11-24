/**
 * What kind of thing a tool does, read from its name: the first known verb
 * among its words, the tool's own part of the name first. Pure. A name with no known verb has no class, and a rule
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

/** One part of a name as words: `getHTTPStatus` → get, http, status. */
const wordsOf = (part: string): string[] =>
  part
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * The first known verb of a name, looking at the tool's own part first and
 * then the namespace parts from the nearest: `create.issue` is a create, and
 * `notify__list_users` a read, not a notify.
 */
const firstVerb = (id: string): string | null => {
  const parts = id.split(/__|[./:]/).filter(Boolean);
  for (const part of parts.reverse()) {
    const verb = wordsOf(part).find((word) => CLASS_OF.has(word));
    if (verb) return verb;
  }
  return null;
};

export function actionClassOf(id: string): ActionClass | null {
  const verb = firstVerb(id);
  return verb === null ? null : (CLASS_OF.get(verb) ?? null);
}

/** A tool that searches, lists or filters. */
export function isProbe(id: string): boolean {
  const verb = firstVerb(id);
  return verb !== null && PROBES.has(verb);
}
