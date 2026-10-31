import type { CatalogTool } from "@/lib/readings/intent-engine/catalog";
import { extractFrames, type Frame } from "@/lib/readings/intent-engine/frames";
import {
  identifierWords,
  STOPWORDS,
  stem,
  type VerbLexicon,
} from "@/lib/readings/intent-engine/text";
import { buildRelevanceIndex, type RelevanceIndex } from "@/lib/readings/query-intents/relevance";

/**
 * What a frame means as an action on a thing, so asks worded differently
 * share one level-1 intent: "add comment to task", "comment on task" and
 * "post a comment" are all create·comment; "give new task id" is create·task.
 *
 *   - Action classes: a small, domain-free map of English verbs that name the
 *     same operation (create, add, make, post…). A verb it does not know is its
 *     own class.
 *   - Objects: the thing acted on is the last word of the frame's object phrase
 *     that the catalog's tool names use ("progress comment" → comment), else the
 *     frame's head object. A verb the catalog uses as a thing ("comment on
 *     task") is that thing, created.
 *   - Grounding: a frame with no action verb is matched against the catalog's
 *     tool names, descriptions and input fields (BM25); a clear best tool gives
 *     the frame that tool's action and object.
 *
 * Static catalog facts only, never what the agent ran: nothing the ranking
 * boosts can feed back into how intents are keyed.
 */

export interface ActionKey {
  /** The action class: a canonical verb, stemmed. */
  action: string;
  /** The thing acted on, stemmed. */
  object: string;
}

/** Relevance the best tool must reach to ground a frame with no verb. */
export const GROUND_TAU = 0.45;
/** Lead the best tool must hold over the next. */
export const GROUND_MARGIN = 0.08;

const CLASSES: Record<string, readonly string[]> = {
  create: [
    "create",
    "add",
    "make",
    "post",
    "insert",
    "register",
    "generate",
    "record",
    "log",
    "new",
  ],
  read: ["get", "show", "view", "read", "fetch", "display", "retrieve", "describe", "load", "see"],
  list: ["list", "browse", "enumerate"],
  update: [
    "update",
    "edit",
    "change",
    "modify",
    "set",
    "mark",
    "rename",
    "patch",
    "adjust",
    "revise",
  ],
  delete: ["delete", "remove", "destroy", "drop", "erase", "purge", "discard"],
  search: ["search", "find", "filter", "lookup", "query", "look"],
  link: ["link", "attach", "associate", "connect"],
  unlink: ["unlink", "detach", "disassociate", "disconnect"],
  assign: ["assign", "reassign", "delegate"],
  move: ["move", "transfer", "relocate"],
  close: ["close", "resolve", "complete", "finish"],
  send: ["send", "email", "message", "forward"],
};
const CLASS_OF = new Map<string, string>();
for (const [cls, words] of Object.entries(CLASSES))
  for (const w of words) CLASS_OF.set(stem(w), stem(cls));

const CREATE = stem("create");
const READ = stem("read");
const LIST = stem("list");
/**
 * Words that name a facet of a thing, not the thing: "task details", "document
 * content", "delivery status". Domain-free; the thing is the word before them.
 * "status" is one: keyed as the thing, "check the delivery status" and "check
 * the payment status" would read as one intent, "check status".
 */
const FACETS = new Set(
  [
    "detail",
    "details",
    "info",
    "information",
    "content",
    "contents",
    "data",
    "metadata",
    "summary",
    "overview",
    "history",
    "list",
    "field",
    "fields",
    "item",
    "items",
    "record",
    "records",
    "status",
    "statuses",
  ].map(stem),
);
/** Not a thing: a facet, or an adverb ("recently updated tasks"). */
const notAThing = (word: string) => FACETS.has(stem(word)) || /ly$/.test(word);

const PHRASE_STOP = new Set([
  "to",
  "for",
  "with",
  "by",
  "in",
  "on",
  "from",
  "into",
  "onto",
  "about",
  "at",
  "via",
  "of",
  "and",
  "then",
  "or",
  "as",
  "per",
]);

/** The action class a verb belongs to: its canonical verb, or itself. */
export function actionClass(verb: string): string {
  return CLASS_OF.get(verb) ?? verb;
}

export interface ActionContext {
  verbs: VerbLexicon;
  /** Every word the catalog's tool names use after their verb, stemmed: the project's things. */
  things: ReadonlySet<string>;
  /** The action a catalog tool pairs with each thing, for a verb used as a thing ("comment on task"). */
  verbOfThing: ReadonlyMap<string, string>;
  /** The verbs the catalog's tool names lead with. */
  toolVerbs: ReadonlySet<string>;
  tools: ReadonlyMap<string, ActionKey | null>;
  grounding: RelevanceIndex;
  /** Each thing as the catalog writes it (stem -> first word seen, singular), for showing the model. */
  thingWords: ReadonlyMap<string, string>;
  /** How many catalog tools name each thing (stem -> count): the ones the model is shown first. */
  thingTools: ReadonlyMap<string, number>;
  /** Each action class the project can key to, as a verb (stem -> word): the universal classes plus the catalog's own verbs. */
  actionWords: ReadonlyMap<string, string>;
}

/** Read the catalog once per run: its tools' actions and things, and the grounding index. */
export function buildActionContext(
  catalog: readonly CatalogTool[],
  verbs: VerbLexicon,
): ActionContext {
  const things = new Set<string>();
  const verbOfThing = new Map<string, string>();
  const tools = new Map<string, ActionKey | null>();
  const toolVerbs = new Set<string>();
  const thingWords = new Map<string, string>();
  const thingTools = new Map<string, number>();
  const actionWords = new Map<string, string>(Object.keys(CLASSES).map((cls) => [stem(cls), cls]));
  for (const tool of catalog) {
    const key = toolKey(tool.name, verbs);
    tools.set(tool.name, key);
    const words = toolWords(tool.name);
    if (key) {
      toolVerbs.add(stem(words[0]));
      if (!actionWords.has(key.action)) actionWords.set(key.action, words[0]);
      for (const w of words.slice(1)) {
        const t = stem(w);
        if (STOPWORDS.has(w) || PHRASE_STOP.has(w) || notAThing(w)) continue;
        things.add(t);
        if (!thingWords.has(t)) thingWords.set(t, singular(w));
        thingTools.set(t, (thingTools.get(t) ?? 0) + 1);
        if (!verbOfThing.has(t)) verbOfThing.set(t, key.action);
      }
    }
  }
  const grounding = buildRelevanceIndex(
    catalog
      .filter((t) => tools.get(t.name))
      .map((t) => ({
        id: t.name,
        text: [
          toolWords(t.name).join(" "),
          t.description ?? "",
          schemaFields(t.inputSchema).join(" "),
        ].join(" "),
      })),
  );
  return {
    verbs,
    things,
    verbOfThing,
    toolVerbs,
    tools,
    grounding,
    thingWords,
    actionWords,
    thingTools,
  };
}

/** Things the model is shown, at most; a large catalog shows the ones most of its tools name. */
export const KEY_OBJECTS = 150;

/** The words the model keys clusters with: every action class, and the catalog's things, singular. */
export function keyVocabulary(ctx: ActionContext): { actions: string[]; objects: string[] } {
  const objects = [...ctx.thingWords.entries()]
    .sort(
      (a, b) =>
        (ctx.thingTools.get(b[0]) ?? 0) - (ctx.thingTools.get(a[0]) ?? 0) ||
        a[1].localeCompare(b[1]),
    )
    .slice(0, KEY_OBJECTS)
    .map(([, word]) => word)
    .sort();
  return { actions: [...ctx.actionWords.values()].sort(), objects };
}

/** A tool name's noun in the singular ("tasks" -> task, "entries" -> entry) when the stem agrees, else as written. */
function singular(word: string): string {
  if (word.length < 4 || /(ss|us|is)$/.test(word)) return word;
  const forms = word.endsWith("ies")
    ? [`${word.slice(0, -3)}y`]
    : word.endsWith("es")
      ? [word.slice(0, -2), word.slice(0, -1)]
      : word.endsWith("s")
        ? [word.slice(0, -1)]
        : [];
  return forms.find((f) => stem(f) === stem(word)) ?? word;
}

/**
 * The model's key for a cluster, or null when it is unusable. The action must
 * be one of the project's action classes (a synonym of one counts); the object
 * is one noun, the catalog's word when it fits, any other otherwise.
 */
export function parseLlmKey(
  raw: { action?: unknown; object?: unknown },
  ctx: ActionContext,
): ActionKey | null {
  const actionWord = lastWord(raw.action);
  const objectWord = lastWord(raw.object);
  if (!actionWord || !objectWord) return null;
  const action = actionClass(stem(actionWord));
  if (!ctx.actionWords.has(action)) return null;
  const object = stem(objectWord);
  if (STOPWORDS.has(objectWord) || PHRASE_STOP.has(objectWord)) return null;
  // A catalog thing is a thing even when it is also a verb somewhere ("link", "comment").
  if (!ctx.things.has(object) && ctx.actionWords.has(object)) return null;
  return { action, object };
}

/** The last word of a short answer ("onboarding checklist" -> checklist), lowercase; null when there is none. */
function lastWord(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const words = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
  return words.length > 0 && words.length <= 3 ? words[words.length - 1] : null;
}

/** A frame's action and object, or null when neither its words nor the catalog say. */
export function actionKey(frame: Frame, ctx: ActionContext): ActionKey | null {
  let verb = frame.head === "none" ? null : frame.action;
  // A frame the lexicon found no verb in may still open with one the class map knows ("mark task as done").
  if (verb === null) verb = classVerb(frame.text);
  if (verb === null) return ground(frame.text, ctx);
  // "comment on task": a verb no tool leads with but the catalog acts on is that thing, acted on.
  // Not when it takes an object of its own: "schedule a site inspection" schedules an inspection.
  if (ctx.things.has(verb) && !ctx.toolVerbs.has(verb) && !takesObject(frame.text, verb)) {
    return { action: ctx.verbOfThing.get(verb) ?? CREATE, object: verb };
  }
  const headObject =
    frame.head === "none" || (frame.object && FACETS.has(frame.object)) ? null : frame.object;
  const object = phraseThing(frame.text, verb, ctx) ?? headObject ?? nextWord(frame.text, verb);
  if (!object) return ground(frame.text, ctx);
  let action = actionClass(verb);
  // "show all tasks": reading many is listing them.
  if (action === READ && readsMany(afterVerb(frame.text, verb), object)) action = LIST;
  return { action, object };
}

/** Whether an object phrase asks for many of its thing: "all tasks", "the tasks". */
function readsMany(phrase: string, object: string): boolean {
  const all = words(phrase);
  return (
    all.some((w) => w === "all" || w === "every") ||
    all.some((w) => stem(w) === object && /[^s]s$/.test(w))
  );
}

/** The first word of `text` the class map reads as a verb, stemmed. */
function classVerb(text: string): string | null {
  for (const w of words(text)) {
    if (STOPWORDS.has(w)) continue;
    const t = stem(w);
    return CLASS_OF.has(t) ? t : null;
  }
  return null;
}

/** The first content word after the verb, stemmed: the object when the catalog names none. */
function nextWord(text: string, verb: string): string | null {
  for (const w of words(afterVerb(text, verb)))
    if (!STOPWORDS.has(w) && !PHRASE_STOP.has(w) && !notAThing(w)) return stem(w);
  return null;
}

/** The object phrase after the verb: up to the first preposition. */
function afterVerb(text: string, verb: string): string {
  const all = words(text);
  const rest = all.slice(all.findIndex((w) => stem(w) === verb) + 1);
  const end = rest.findIndex((w, i) => i > 0 && PHRASE_STOP.has(w));
  return (end < 0 ? rest : rest.slice(0, end)).join(" ");
}

/** Whether the verb's next word starts an object ("schedule a site inspection"), not a preposition ("comment on task"). */
function takesObject(text: string, verb: string): boolean {
  const all = words(text);
  const at = all.findIndex((w) => stem(w) === verb);
  const next = at >= 0 ? all[at + 1] : undefined;
  return next !== undefined && !PHRASE_STOP.has(next);
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * A cluster member's key, for keyed levels: a member that reads as several
 * actions (a raw search kept from before frames) has none, so it does not vote.
 */
export function memberKey(member: string, ctx: ActionContext): ActionKey | null {
  const frames = extractFrames(member, ctx.verbs);
  return frames.length === 1 ? actionKey(frames[0], ctx) : null;
}

function ground(text: string, ctx: ActionContext): ActionKey | null {
  const [best, next] = ctx.grounding.search(text, 2);
  if (!best || best.relevance < GROUND_TAU) return null;
  if (next && best.relevance - next.relevance < GROUND_MARGIN) return null;
  return ctx.tools.get(best.id) ?? null;
}

/** The last word of the object phrase after the frame's verb that names one of the catalog's things. */
function phraseThing(text: string, action: string, ctx: ActionContext): string | null {
  const all = words(text);
  const at = all.findIndex((w) => stem(w) === action);
  let thing: string | null = null;
  for (const w of all.slice(at + 1)) {
    if (PHRASE_STOP.has(w) || /(?:ed|ing)$/.test(w)) {
      if (thing) break;
      continue;
    }
    const t = stem(w);
    if (ctx.things.has(t) && !notAThing(w)) thing = t;
  }
  return thing;
}

function toolWords(name: string): string[] {
  return identifierWords(name.split(/__|::|[./:]/).pop() ?? name);
}

/** A tool's action and object from its name: `add_task_comment` → create·comment, `search_tasks_by_text` → search·task. */
function toolKey(name: string, verbs: VerbLexicon): ActionKey | null {
  const words = toolWords(name);
  if (words.length < 2 || !verbs.has(stem(words[0]))) return null;
  let object: string | null = null;
  for (const w of words.slice(1)) {
    if (PHRASE_STOP.has(w)) break;
    if (!STOPWORDS.has(w) && !notAThing(w)) object = stem(w);
  }
  return object ? { action: actionClass(stem(words[0])), object } : null;
}

/** The property names of a JSON schema, one level deep: the inputs a tool takes. */
function schemaFields(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const props = (schema as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props).flatMap((k) => identifierWords(k));
}
