import { randomUUID } from "node:crypto";
import type { ActionKey } from "@/lib/readings/intent-engine/actions";
import { buildClusterIndex } from "@/lib/readings/intent-engine/match";
import {
  centralPhrases,
  displayWord,
  maskedTemplate,
  medoid,
  objectName,
} from "@/lib/readings/intent-engine/naming";
import {
  maskArguments,
  stem,
  tokenizeForRelevance,
  toolFamily,
  type VerbLexicon,
} from "@/lib/readings/intent-engine/text";
import type { LevelNode, LevelTree } from "@/lib/readings/intent-types/engine-types";

/**
 * The hierarchy above the engine's clusters, one level at a time, with one
 * wording threshold throughout. What each level compares gets more general:
 *
 *   level 1: arguments masked, same action verb: "assign this task to emp-1"
 *             and "... to emp-2" both read "assign this task to {id}". A
 *             name has no shape to mask by, so a word only one cluster uses
 *             is masked too ("... to alice", "... to bob"), unless it is the
 *             action or the phrase would keep no word another cluster shares;
 *   level 2: the action dropped, objects only: "assign / create / update
 *             task" all read "task";
 *   level 3+: only the terms most of a group's phrases share; built only
 *             when a caller raises `maxLevels` past the default of 2.
 *
 * Levels 1 and 2 always exist, each asking its own question, even when it
 * merges nothing: level 0 may already have merged what level 1 would, and
 * level 2 can still group what level 1 kept apart. From level 3 on the
 * question repeats, so a level that merges nothing ends the hierarchy and
 * depth follows the project. Every node gets a parent on every level that
 * exists (a group of one when nothing joins it), so any level can be read
 * alone; skill gaps and Tool Craft read level 1. Tool family
 * (the MCP server or namespace a node's tools share) is supporting evidence:
 * it lets wording just under the threshold join, never zero wording.
 *
 * With intent frames on, level 1 is keyed instead: each node's action and
 * object (`./actions.ts`), the key most of its members read as, and nodes
 * with one key are one intent however differently they are worded ("give new
 * task id" and "create task"). Level 2 then groups by the key's object. A
 * node with no key falls back to the wording rules above. Keys are read from
 * members on every rebuild, so nothing is stored for them.
 *
 * Ids are kept across rebuilds: a group takes the id of the previous node
 * whose children it overlaps most (Jaccard ≥ 0.5), so a level-1 intent keeps
 * its id while its children come and go.
 */

export const LEVEL_TAU = 0.6;
/** Phrases that stand for a node when it is compared at a level. */
const CENTRAL_PHRASES = 3;
/** Wording this far under the threshold joins when the two share a tool family. */
export const FAMILY_BAND = 0.15;
/**
 * The hierarchy stops at domains (level 2). Levels above it (shared object
 * terms) are still built for a caller that asks for them with `maxLevels`.
 */
export const MAX_LEVELS = 2;
/** Levels built whether or not they merge: masked arguments (1) and objects (2). */
export const FIXED_LEVELS = 2;
const STABLE_ID_JACCARD = 0.5;
/** Phrases kept per node for comparison and naming. */
const NODE_PHRASES = 200;
const PLACEHOLDERS = new Set(["url", "email", "path", "value", "id"]);

export interface LevelInput {
  uuid: string;
  members: readonly string[];
  /** Ordering weight: asks behind the cluster. */
  weight: number;
  /** Tool ids the cluster's asks led to. */
  tools: readonly string[];
  /** The model's action and object for the cluster, when model keys are on; absent, the rule-based key. */
  llmKey?: ActionKey | null;
}

export interface PriorNode {
  uuid: string;
  level: number;
  children: readonly string[];
}

export interface LevelOptions {
  tau?: number;
  familyBand?: number;
  maxLevels?: number;
  /** A member's action and object, when level 1 is keyed (intent frames on). */
  keyOf?: (member: string) => ActionKey | null;
}

/** Share of a node's keyed members its most common key must hold to be its key. */
export const KEY_SHARE = 0.5;

interface Node {
  uuid: string;
  level: number;
  children: string[];
  weight: number;
  /** Raw member texts of every level-0 descendant, capped. */
  raw: string[];
  /** The same, arguments masked. */
  masked: string[];
  tools: string[];
  families: Set<string>;
  label: string;
  terms: string[];
  /** The node's action and object, when level 1 is keyed. */
  key: ActionKey | null;
}

export function buildLevels(
  level0: readonly LevelInput[],
  prior: readonly PriorNode[],
  verbs: VerbLexicon,
  options: LevelOptions = {},
): LevelTree {
  const tau = options.tau ?? LEVEL_TAU;
  const band = options.familyBand ?? FAMILY_BAND;
  const maxLevels = options.maxLevels ?? MAX_LEVELS;
  const tree: LevelTree = { levels: [[]], parentOf: new Map() };

  const rare = rareTerms(level0);
  let nodes: Node[] = level0.map((c) => {
    const raw = c.members.slice(0, NODE_PHRASES);
    return {
      uuid: c.uuid,
      level: 0,
      children: [],
      weight: c.weight,
      raw,
      masked: raw.map((m) => maskRare(maskArguments(m).masked, rare, verbs)),
      tools: [...c.tools],
      families: familiesOf(c.tools),
      label: "",
      terms: [],
      key: c.llmKey ?? (options.keyOf ? majorityKey(raw, options.keyOf) : null),
    };
  });

  for (let level = 1; level <= maxLevels && nodes.length > 0; level += 1) {
    if (level > FIXED_LEVELS && nodes.length < 2) break;
    const reps = new Map(nodes.map((n) => [n.uuid, representation(n, level, verbs)]));
    const groups =
      level === 1 && options.keyOf
        ? [
            ...groupByKey(nodes.filter((n) => n.key)),
            ...group(
              nodes.filter((n) => !n.key),
              reps,
              level,
              verbs,
              tau,
              band,
            ),
          ]
        : group(nodes, reps, level, verbs, tau, band);
    if (level > FIXED_LEVELS && groups.every((g) => g.length === 1)) break;
    const priorHere = prior.filter((p) => p.level === level);
    const used = new Set<string>();
    const next: Node[] = groups.map((members) => {
      const children = members.map((m) => m.uuid);
      const uuid = stableId(children, priorHere, used) ?? randomUUID();
      const raw = cap(members.flatMap((m) => m.raw));
      const node: Node = {
        uuid,
        level,
        children,
        weight: members.reduce((sum, m) => sum + m.weight, 0),
        raw,
        masked: members.flatMap((m) => m.masked).slice(0, NODE_PHRASES),
        tools: [...new Set(members.flatMap((m) => m.tools))],
        families: new Set(members.flatMap((m) => [...m.families])),
        label: "",
        terms: [],
        // Level 1 carries its key; level 2 the key it was grouped on, so it is named for the object.
        key: level <= 2 ? (members[0].key ?? null) : null,
      };
      const objects = topObjects(node, verbs);
      node.terms = objects.slice(0, 5);
      const heads = level === 2 ? representation(node, 2, verbs) : [];
      node.label =
        level === 1 && node.key
          ? keyName(node.key, node.raw)
          : level === 1
            ? readableTemplate(node.masked, node.raw)
            : objectName(heads.length > 0 ? heads : objects, node.raw, node.tools) ||
              heaviest(members).label ||
              maskedTemplate(node.raw);
      for (const child of children) tree.parentOf.set(child, uuid);
      return node;
    });
    tree.levels.push(
      next.map(
        (n): LevelNode => ({
          uuid: n.uuid,
          level,
          children: n.children,
          label: n.label,
          terms: n.terms,
        }),
      ),
    );
    nodes = next;
  }
  return tree;
}

/** What a node is compared on at `level` (see the module comment). */
function representation(node: Node, level: number, verbs: VerbLexicon): string[] {
  if (level === 1) return node.masked;
  if (level === 2 && node.key) return [node.key.object];
  if (level === 2) {
    // The object most of the node's asks act on: one word, so a group is one entity.
    const heads = new Map<string, number>();
    for (const p of node.masked) {
      const head = verbs.headObject(p, PLACEHOLDERS);
      if (head) heads.set(head, (heads.get(head) ?? 0) + 1);
    }
    const top = [...heads.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return top ? [top[0]] : [];
  }
  const objects = node.masked
    .map((p) => objectTermsOf(p, verbs).join(" "))
    .filter((p) => p.length > 0);
  // Level 3 and up: the terms at least half the node's phrases share.
  const df = new Map<string, number>();
  for (const p of objects) for (const t of new Set(p.split(" "))) df.set(t, (df.get(t) ?? 0) + 1);
  const ranked = [...df.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const core = ranked.filter(([, n]) => n * 2 >= objects.length).map(([t]) => t);
  const terms = core.length > 0 ? core : ranked.slice(0, 1).map(([t]) => t);
  return terms.length > 0 ? [terms.join(" ")] : [];
}

/**
 * A level-1 name: the masked template its asks share, unless masking left it
 * more placeholder than words; then the most typical real ask reads better.
 */
function readableTemplate(masked: readonly string[], raw: readonly string[]): string {
  const template = maskedTemplate(masked);
  const placeholders = (template.match(/\{(url|email|path|value|id)\}/g) ?? []).length;
  const words = tokenizeForRelevance(template).filter((t) => !PLACEHOLDERS.has(t)).length;
  return placeholders * 2 > words ? medoid(raw) : template;
}

/** Terms exactly one level-0 cluster uses: the names and values its asks carry. */
function rareTerms(level0: readonly LevelInput[]): Set<string> {
  const df = new Map<string, number>();
  for (const c of level0) {
    const terms = new Set(c.members.flatMap((m) => tokenizeForRelevance(m)));
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return new Set([...df].filter(([, n]) => n === 1).map(([t]) => t));
}

/**
 * Mask a phrase's rare words as values. The lead verb and known verbs stay;
 * and nothing is masked unless a non-verb word another cluster shares stays,
 * so "summarize standup notes" does not collapse to "summarize {value}".
 */
function maskRare(phrase: string, rare: ReadonlySet<string>, verbs: VerbLexicon): string {
  const words = phrase.split(/(\s+)/);
  const termOf = (word: string) => tokenizeForRelevance(word)[0];
  const lead = verbs.leadVerb(phrase);
  const keepsShared = words.some((w) => {
    const t = termOf(w);
    return t !== undefined && t !== lead && !verbs.has(t) && !rare.has(t) && !PLACEHOLDERS.has(t);
  });
  if (!keepsShared) return phrase;
  return words
    .map((w) => {
      const t = termOf(w);
      if (t === undefined || t === lead || verbs.has(t) || !rare.has(t)) return w;
      return "{value}";
    })
    .join("");
}

function objectTermsOf(phrase: string, verbs: VerbLexicon): string[] {
  return verbs.objectTerms(phrase).filter((t) => !PLACEHOLDERS.has(t));
}

/** The key most of a node's members read as, or null: members with no key, or several actions, do not vote. */
function majorityKey(
  members: readonly string[],
  keyOf: (member: string) => ActionKey | null,
): ActionKey | null {
  const counts = new Map<string, { key: ActionKey; n: number }>();
  let voted = 0;
  for (const m of members) {
    const key = keyOf(m);
    if (!key) continue;
    voted += 1;
    const id = `${key.action}\u0000${key.object}`;
    const seen = counts.get(id);
    if (seen) seen.n += 1;
    else counts.set(id, { key, n: 1 });
  }
  if (voted === 0) return null;
  const [top] = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1));
  return top[1].n / voted >= KEY_SHARE ? top[1].key : null;
}

/** Keyed level 1: one group per key, heaviest node first. */
function groupByKey(nodes: readonly Node[]): Node[][] {
  const groups = new Map<string, Node[]>();
  const ordered = [...nodes].sort((a, b) => b.weight - a.weight || (a.uuid < b.uuid ? -1 : 1));
  for (const n of ordered) {
    const id = `${n.key!.action}\u0000${n.key!.object}`;
    const g = groups.get(id);
    if (g) g.push(n);
    else groups.set(id, [n]);
  }
  return [...groups.values()];
}

/** A keyed intent's name: "Create task", in the words its asks use for the thing. */
function keyName(key: ActionKey, phrases: readonly string[]): string {
  const action = ACTION_WORDS.get(key.action) ?? displayWord(key.action, phrases);
  const name = `${action} ${displayWord(key.object, phrases)}`;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The canonical verbs, as written: an action class is named by its own verb. */
const ACTION_WORDS = new Map(
  [
    "create",
    "read",
    "list",
    "update",
    "delete",
    "search",
    "link",
    "unlink",
    "assign",
    "move",
    "close",
    "send",
  ].map((w) => [stem(w), w]),
);

/** Star grouping, heaviest first; a node joins a survivor directly, never through a third. */
function group(
  nodes: readonly Node[],
  reps: ReadonlyMap<string, string[]>,
  level: number,
  verbs: VerbLexicon,
  tau: number,
  band: number,
): Node[][] {
  const ordered = [...nodes].sort((a, b) => b.weight - a.weight || a.uuid.localeCompare(b.uuid));
  const index = buildClusterIndex(
    ordered.map((n, rank) => ({ key: n.uuid, members: reps.get(n.uuid) ?? [], usage: {}, rank })),
  );
  const byUuid = new Map(nodes.map((n) => [n.uuid, n]));
  const dominant = new Map(nodes.map((n) => [n.uuid, dominantVerb(n.masked, verbs)]));
  const assigned = new Set<string>();
  const out: Node[][] = [];
  for (const survivor of ordered) {
    if (assigned.has(survivor.uuid)) continue;
    assigned.add(survivor.uuid);
    // A candidate is compared with the survivor's most central phrases, the few
    // that stand for it, and must be close to them on average: not the single best
    // phrase pair, so one member that bridges to another node cannot group them
    // (single-linkage chaining). A bridge is the least central phrase there is.
    const all = reps.get(survivor.uuid) ?? [];
    const central = centralPhrases(all, Math.min(CENTRAL_PHRASES, all.length));
    const scores = new Map<string, number>();
    for (const phrase of central) {
      for (const c of index.candidates(phrase, new Set()))
        scores.set(c.key, (scores.get(c.key) ?? 0) + c.wording);
    }
    const best = new Map<string, number>();
    for (const [key, sum] of scores) best.set(key, sum / Math.max(1, central.length));
    const members = [survivor];
    for (const [key, wording] of [...best.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )) {
      if (assigned.has(key) || key === survivor.uuid) continue;
      const other = byUuid.get(key)!;
      // Level 1 groups one action with different arguments: both nodes must have
      // the same dominant action. A node with none (verb-less asks, or no verb
      // most of its asks share) waits for level 2.
      if (level === 1) {
        const mine = dominant.get(survivor.uuid);
        if (!mine || mine !== dominant.get(key)) continue;
      }
      const familyOk = sharesAny(survivor.families, other.families);
      if (wording >= tau || (familyOk && wording >= tau - band)) {
        members.push(other);
        assigned.add(key);
      }
    }
    out.push(members);
  }
  return out;
}

/** Share of a node's verbed phrases its most common lead verb must hold to be its action. */
export const DOMINANT_VERB_SHARE = 0.5;

/**
 * The action most of a node's phrases lead with, or null: phrases with no
 * lead verb do not vote, and no verb at all, or none holding half the votes,
 * means the node has no one action.
 */
export function dominantVerb(phrases: readonly string[], verbs: VerbLexicon): string | null {
  const counts = new Map<string, number>();
  let voted = 0;
  for (const p of phrases) {
    const v = verbs.leadVerb(p);
    if (!v) continue;
    voted += 1;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (voted === 0) return null;
  const [verb, n] = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0];
  return n / voted >= DOMINANT_VERB_SHARE ? verb : null;
}

function stableId(
  children: readonly string[],
  prior: readonly PriorNode[],
  used: Set<string>,
): string | null {
  const mine = new Set(children);
  let best: string | null = null;
  let bestScore = 0;
  for (const p of prior) {
    if (used.has(p.uuid)) continue;
    let inter = 0;
    for (const c of p.children) if (mine.has(c)) inter += 1;
    const score = inter / (mine.size + p.children.length - inter);
    if (score >= STABLE_ID_JACCARD && score > bestScore) {
      best = p.uuid;
      bestScore = score;
    }
  }
  if (best) used.add(best);
  return best;
}

function topObjects(node: Node, verbs: VerbLexicon): string[] {
  const df = new Map<string, number>();
  for (const p of node.masked)
    for (const t of new Set(objectTermsOf(p, verbs))) df.set(t, (df.get(t) ?? 0) + 1);
  // Only terms most of the group shares name it; a term one child uses is detail.
  const half = node.masked.length / 2;
  return [...df.entries()]
    .filter(([, n]) => n >= half)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

function familiesOf(toolIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of toolIds) {
    const family = toolFamily(id);
    if (family) out.add(family);
  }
  return out;
}

function sharesAny<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function heaviest(nodes: readonly Node[]): Node {
  return nodes.reduce((a, b) => (b.weight > a.weight ? b : a));
}

function cap(phrases: readonly string[]): string[] {
  return [...new Set(phrases)].slice(0, NODE_PHRASES);
}
