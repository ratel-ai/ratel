import {
  identifierTokens,
  looksLikeIdentifier,
  STOPWORDS,
  stem,
  tokenizeForRelevance,
} from "@/lib/readings/query-intents/relevance";

/**
 * The text rules every part of the intent engine shares: one tokenizer, one
 * stemmer, one stopword list, so a cluster is matched, compacted, levelled and
 * named over the same terms. The tokenizer is the coverage scorer's
 * (`lib/query-intents/relevance.ts`), so a cluster's wording and a skill's
 * description are cut up the same way when skill gaps are scored.
 *
 * Nothing here calls a model. Privacy: asks are raw user text; nothing here logs.
 */

export { identifierTokens, looksLikeIdentifier, STOPWORDS, stem, tokenizeForRelevance };

/** Longest ask text the engine keeps or scores. Matches the OTLP prompt cap. */
export const ASK_TEXT_MAX = 1_000;
/** Longest text kept for one cluster member. */
export const MEMBER_TEXT_MAX = 300;

/** Collapse whitespace and cap length. Returns "" for text with no words. */
export function cleanAskText(text: string, max: number = ASK_TEXT_MAX): string {
  const flat = text
    // Fenced code and pasted logs carry no intent and dominate the term counts.
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(flat)) return "";
  return flat.length <= max ? flat : flat.slice(0, max).trimEnd();
}

/* clauses */

/** A later clause pointing back at the object before it ("fix the failed ones"). */
export const ANAPHOR = /\b(?:the\s+)?(?:ones|it|them|those|these)\b/i;
/** A leading article or possessive, dropped when an object phrase is carried into another clause. */
export const ARTICLES = /^(?:a|an|the|this|that|these|those|my|our|your|its|their)\s+/i;

/* argument masking */

/**
 * The placeholder words masking leaves behind. Each tokenizes to itself, so two
 * masked asks that differ only in the value they name share the placeholder term.
 */
export type ArgumentSlot = "url" | "email" | "path" | "value" | "id";
const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set(["url", "email", "path", "value", "id"]);

export interface MaskedText {
  masked: string;
  /** The kinds masked, in order of appearance. */
  slots: ArgumentSlot[];
}

const MASKS: ReadonlyArray<readonly [ArgumentSlot, RegExp]> = [
  ["url", /\bhttps?:\/\/[^\s)>\]"']+/gi],
  ["email", /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g],
  [
    "value",
    /"[^"\n]{1,200}"|“[^”\n]{1,200}”|`[^`\n]{1,200}`|(?<![\p{L}\p{N}])'[^'\n]{1,200}'(?![\p{L}\p{N}])/gu,
  ],
  // A path needs a root (`/`, `~/`, `./`), a file extension, or two separators,
  // so "and/or" and "client/server" stay words.
  [
    "path",
    /(?<![\p{L}\p{N}/])(?:(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]+)*|[\w-]+(?:\/[\w.-]+){2,}|[\w-]+(?:\/[\w-]+)*\/[\w-]+\.[A-Za-z0-9]{1,6})(?![\p{L}\p{N}])/gu,
  ],
  // Ticket and record keys (`RC-208`, `emp-1`), uuids, hashes, and any word carrying a digit.
  ["id", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ["id", /\b[A-Za-z]{1,12}-\d+\b/g],
  ["id", /\b[\w-]*\d[\w-]*\b/g],
];

/**
 * Replace the values an ask names (urls, emails, quoted strings, paths, ids,
 * numbers, code identifiers) with placeholder words, so "assign this task to
 * emp-1" and "... to emp-2" read the same. Level 1 compares masked text.
 */
export function maskArguments(text: string): MaskedText {
  const found: Array<{ at: number; slot: ArgumentSlot }> = [];
  let masked = text;
  for (const [slot, pattern] of MASKS) {
    masked = masked.replace(pattern, (_match: string, ...rest: unknown[]) => {
      const offset = rest.find((r) => typeof r === "number") as number | undefined;
      found.push({ at: offset ?? 0, slot });
      return ` {${slot}} `;
    });
  }
  // A code identifier (camelCase, snake_case, dotted) names the thing worked on.
  masked = masked
    .split(/(\s+)/)
    .map((word) => {
      const bare = word.replace(/^[^\p{L}\p{N}_{]+|[^\p{L}\p{N}_}]+$/gu, "");
      if (!bare || bare.startsWith("{") || !looksLikeIdentifier(bare)) return word;
      found.push({ at: Number.MAX_SAFE_INTEGER, slot: "id" });
      return word.replace(bare, "{id}");
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  // An ask that is nothing but values (an agent searching by a tool's name:
  // "search_tasks") keeps its words: masked, every such ask would read alike.
  const content = tokenizeForRelevance(masked).filter((t) => !PLACEHOLDER_WORDS.has(t));
  if (content.length === 0) return { masked: text.replace(/\s+/g, " ").trim(), slots: [] };
  found.sort((a, b) => a.at - b.at);
  return { masked, slots: found.map((f) => f.slot) };
}

/* verbs and objects */

/**
 * Action verbs every project starts with. A project's own verbs are added from
 * its tool names and from the first word of its asks ({@link VerbLexicon.learn}).
 * Stemmed, as the tokenizer leaves them.
 */
const BASE_VERBS = [
  "add",
  "analyze",
  "approve",
  "archive",
  "assign",
  "book",
  "build",
  "calculate",
  "cancel",
  "change",
  "check",
  "clean",
  "close",
  "comment",
  "compare",
  "configure",
  "convert",
  "copy",
  "create",
  "debug",
  "delete",
  "deploy",
  "describe",
  "download",
  "draft",
  "edit",
  "enable",
  "disable",
  "explain",
  "export",
  "fetch",
  "filter",
  "find",
  "fix",
  "generate",
  "get",
  "import",
  "install",
  "investigate",
  "invite",
  "label",
  "link",
  "list",
  "load",
  "lookup",
  "merge",
  "migrate",
  "monitor",
  "move",
  "notify",
  "open",
  "plan",
  "post",
  "prioritize",
  "publish",
  "pull",
  "push",
  "query",
  "read",
  "rebase",
  "refund",
  "reject",
  "release",
  "remove",
  "rename",
  "reopen",
  "reply",
  "report",
  "rerun",
  "reset",
  "resolve",
  "restart",
  "retry",
  "review",
  "revert",
  "run",
  "schedule",
  "search",
  "send",
  "set",
  "share",
  "show",
  "sort",
  "start",
  "stop",
  "submit",
  "summarize",
  "sync",
  "tag",
  "test",
  "track",
  "translate",
  "triage",
  "update",
  "upgrade",
  "upload",
  "validate",
  "verify",
  "view",
  "write",
].map(stem);

/** Words that look like a namespace in a tool id: `github__create_issue`, `mcp.jira.search`. */
const NAMESPACE_SEPARATORS = /__|::|[./:]/;

/** Split a tool or skill id into its words: `createIssue`, `create_issue`, `create-issue`. */
export function identifierWords(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

/**
 * The family a tool belongs to: the namespace of its id when it has one
 * (`github__create_issue` → `github`), else null. Tools of one MCP server
 * share it, which is the level-2 "same topic" evidence that needs no wording.
 */
export function toolFamily(toolId: string): string | null {
  const parts = toolId.split(NAMESPACE_SEPARATORS).filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  // `mcp__server__tool`: the generic MCP prefix is not a family.
  const head = parts[0].toLowerCase() === "mcp" && parts.length > 2 ? parts[1] : parts[0];
  return head.toLowerCase();
}

/** The project's action verbs: the base list plus what its tools and asks teach. */
export class VerbLexicon {
  private readonly verbs = new Set<string>(BASE_VERBS);

  /** The nouns the catalog's tool names are built from (`create_task` → "task"): the project's entities. */
  private readonly nouns = new Set<string>();
  /** What each tool verb acts on, from the rest of its tool names (`add_task_comment` → add: task, comment). */
  private readonly objectsOf = new Map<string, Set<string>>();

  /** Learn the verb a tool id leads with (`create_issue` → `create`), when it reads as one. */
  learnTool(toolId: string): void {
    const words = identifierWords(toolId.split(NAMESPACE_SEPARATORS).pop() ?? toolId);
    const first = words[0];
    // Only a word that is already a verb somewhere else, or ends like one, is
    // taken from a tool name: `issue_tracker` must not make "issue" a verb.
    if (
      first &&
      words.length > 1 &&
      (this.verbs.has(stem(first)) || /(ate|ify|ize|ise)$/.test(first))
    ) {
      this.verbs.add(stem(first));
    }
    for (const word of words) {
      const term = stem(word);
      if (word.length >= 3 && !this.verbs.has(term) && !STOPWORDS.has(word)) this.nouns.add(term);
    }
    const verb = first ? stem(first) : null;
    if (verb && words.length > 1 && this.verbs.has(verb)) {
      let objects = this.objectsOf.get(verb);
      if (!objects) this.objectsOf.set(verb, (objects = new Set()));
      for (const word of words.slice(1)) if (!STOPWORDS.has(word)) objects.add(stem(word));
    }
  }

  /** Whether a catalog tool led by `verb` names `term` as what it acts on: "comment" for add (`add_task_comment`). */
  actsOn(verb: string, term: string): boolean {
    return this.objectsOf.get(verb)?.has(term) ?? false;
  }

  /** Whether `term` names one of the catalog's entities. */
  isEntity(term: string): boolean {
    return this.nouns.has(term);
  }

  /**
   * The thing an ask acts on: its first object term that names one of the
   * catalog's entities, else its first object term. "read complete document
   * content" acts on "document", not on "complete".
   */
  headObject(text: string, ignore: ReadonlySet<string> = new Set()): string | null {
    const objects = this.objectTerms(text).filter((t) => !ignore.has(t) && !this.verbs.has(t));
    return objects.find((t) => this.nouns.has(t)) ?? objects[0] ?? null;
  }

  has(term: string): boolean {
    return this.verbs.has(term);
  }

  /** Whether an ask (or clause) opens with an action verb. */
  startsWithVerb(text: string): boolean {
    const first = tokenizeForRelevance(text)[0];
    return first !== undefined && this.verbs.has(first);
  }

  /**
   * What the ask acts on: its terms with the leading action verb dropped. Only
   * the lead word is a verb by position; "tests" in "fix the CI tests" is the
   * object even though "test" is also a verb.
   */
  objectTerms(text: string): string[] {
    const terms = tokenizeForRelevance(text);
    return terms.length > 1 && this.verbs.has(terms[0]) ? terms.slice(1) : terms;
  }

  /** The leading action verb of `text`, or null. */
  leadVerb(text: string): string | null {
    const first = tokenizeForRelevance(text)[0];
    return first !== undefined && this.verbs.has(first) ? first : null;
  }
}

/**
 * Words the catalog teaches the tokenizer: every tool and skill id split into
 * its parts, so "create issue" and `create_issue` share terms. Returned as text
 * a caller appends to the documents it indexes, which is all the vocabulary
 * needs to do: make those terms known to the index's idf.
 */
export function catalogVocabulary(ids: Iterable<string>): string {
  const words = new Set<string>();
  for (const id of ids) for (const w of identifierWords(id)) if (w.length >= 2) words.add(w);
  return [...words].join(" ");
}

/** Distinct stemmed terms of `text`, stopwords dropped. */
export function termSet(text: string): Set<string> {
  return new Set(tokenizeForRelevance(text));
}

/** A tool id written into an ask: `create_task`, `addTaskComment`. */
const TOOL_ID = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g;
/** A purpose clause ("… to create a task", "in order to link it"): its verb serves the ask, it is not a second one. */
const PURPOSE = /\b(?:in\s+order\s+)?to\s+([a-z]+)/gi;

/**
 * How many actions an ask asks for: tool ids it names whose first word is an
 * action, plus action verbs in the rest. A verb right after another counts once
 * ("add comment", "delete or remove"), a purpose clause's verb not at all, and a
 * later verb in a noun's plural form is the noun ("check the CI tests"). Two or
 * more means the ask holds several requests.
 */
export function actionHeads(text: string, verbs: VerbLexicon): number {
  let heads = 0;
  const rest = text.replace(TOOL_ID, (id) => {
    const words = identifierWords(id);
    if (words.length > 1 && verbs.has(stem(words[0]))) heads += 1;
    return " ";
  });
  let previousWasVerb = false;
  for (const raw of rest
    .replace(PURPOSE, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const isVerb = verbs.has(stem(raw));
    const plural = /[^s]s$/.test(raw);
    if (isVerb && !previousWasVerb && (heads === 0 || !plural)) heads += 1;
    previousWasVerb = isVerb;
  }
  return heads;
}
