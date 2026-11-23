import { dominantVerb } from "@/lib/readings/intent-engine/levels";
import { actionHeads, maskArguments, type VerbLexicon } from "@/lib/readings/intent-engine/text";

/**
 * How well a project's engine state reads its asks as intents, from the
 * clusters, the hierarchy and the assignments alone: no labels needed, so it
 * runs on any project before and after a change to the engine.
 */

export interface DiagnoseCluster {
  uuid: string;
  members: readonly string[];
}

export interface DiagnoseNode {
  uuid: string;
  level: number;
  children: readonly string[];
}

export interface DiagnoseAssignment {
  eventId: string;
  askIndex: number;
}

export interface EngineDiagnosis {
  clusters: number;
  /** Share of level-0 clusters with one member. */
  singletonShare0: number;
  intents: number;
  /** Share of level-1 intents with one child. */
  singletonShare1: number;
  /** Level-1 intents whose children lead with different actions. */
  mixedActionIntents: Array<{ uuid: string; verbs: string[] }>;
  members: number;
  /** Members that name two or more actions: asks that should have been read as several. */
  multiActionMembers: number;
  asks: number;
  /** Share of asks placed in more than one cluster (split or contained). */
  splitShare: number;
}

const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

export interface DiagnoseOptions {
  /** A member's action, when intents are keyed (frames): its action class. Default: its lead verb. */
  actionOf?: (member: string) => string | null;
  /** How many actions a member asks for. Default: {@link actionHeads}. */
  actionsIn?: (member: string) => number;
}

/** The action most of a cluster's members name, or null: none holding half the votes. */
function majority(
  members: readonly string[],
  actionOf: (member: string) => string | null,
): string | null {
  const counts = new Map<string, number>();
  let voted = 0;
  for (const m of members) {
    const a = actionOf(m);
    if (!a) continue;
    voted += 1;
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const [top] = [...counts.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  return top && top[1] * 2 >= voted ? top[0] : null;
}

export function diagnoseEngine(
  clusters: readonly DiagnoseCluster[],
  nodes: readonly DiagnoseNode[],
  assignments: readonly DiagnoseAssignment[],
  verbs: VerbLexicon,
  options: DiagnoseOptions = {},
): EngineDiagnosis {
  const actionsIn = options.actionsIn ?? ((m: string) => actionHeads(m, verbs));
  const verbOf = new Map<string, string | null>();
  for (const c of clusters) {
    verbOf.set(
      c.uuid,
      options.actionOf
        ? majority(c.members, options.actionOf)
        : dominantVerb(
            c.members.map((m) => maskArguments(m).masked),
            verbs,
          ),
    );
  }

  const intents = nodes.filter((n) => n.level === 1);
  const mixedActionIntents: EngineDiagnosis["mixedActionIntents"] = [];
  for (const n of intents) {
    const distinct = new Set<string>();
    for (const child of n.children) {
      const v = verbOf.get(child);
      if (v) distinct.add(v);
    }
    if (distinct.size > 1) mixedActionIntents.push({ uuid: n.uuid, verbs: [...distinct].sort() });
  }

  let members = 0;
  let multiActionMembers = 0;
  for (const c of clusters) {
    for (const m of c.members) {
      members += 1;
      if (actionsIn(m) >= 2) multiActionMembers += 1;
    }
  }

  const parts = new Map<string, number>();
  for (const a of assignments) parts.set(a.eventId, (parts.get(a.eventId) ?? 0) + 1);
  let split = 0;
  for (const n of parts.values()) if (n > 1) split += 1;

  return {
    clusters: clusters.length,
    singletonShare0: share(clusters.filter((c) => c.members.length <= 1).length, clusters.length),
    intents: intents.length,
    singletonShare1: share(intents.filter((n) => n.children.length <= 1).length, intents.length),
    mixedActionIntents,
    members,
    multiActionMembers,
    asks: parts.size,
    splitShare: share(split, parts.size),
  };
}
