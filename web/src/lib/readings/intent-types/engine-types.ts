import type { IntentGraphIntent } from "@/lib/readings/intent-types/wire";

/**
 * The intent engine's working shapes. A level-0 cluster is shaped like a wire
 * intent (`lib/intent-graph/wire.ts`) so the adaptive-ranking compaction pass
 * runs over it unchanged, and carries what only Cloud needs beside it.
 *
 * Privacy: `members` and ask `text` are raw user text. Never log them.
 */

/** Where an ask's text came from, best first: what the user typed, the model call's prompt, the agent's search. */
export type AskKind = "user_message" | "prompt" | "search";

export const ASK_KIND_PRIORITY: Readonly<Record<AskKind, number>> = {
  user_message: 0,
  prompt: 1,
  search: 2,
};

/** Counts behind a served cluster, per source as well as merged. */
export interface CapabilityEdges {
  tools: Record<string, number>;
  skills: Record<string, number>;
  surfaced_tools?: Record<string, number>;
  surfaced_skills?: Record<string, number>;
}

/** A source's slice of a cluster: what its own `cloud/<source>` graph serves. */
export interface SourceSlice extends CapabilityEdges {
  /** This cluster's id in the source's graph (`intent_N`), stable across folds. */
  graphId: string;
  support: number;
  members: string[];
  last_ts?: number;
}

/**
 * A level-0 cluster. `id` is the wire id (`intent_N`); `uuid` is the row id.
 *
 * Two edge sets on purpose. `tools`/`skills` follow the SDK learner exactly
 * (a confirmed search or prompt credits what the agent then ran) and are what
 * runtimes are served. `usage` counts what any ask's turn ran, a user message's
 * included, and is only matching evidence. A cluster with no `tools`/`skills`
 * is never served.
 */
export interface EngineCluster extends IntentGraphIntent {
  uuid: string;
  /** Every ask text that joined, any kind; the match key. Capped. */
  members: string[];
  /** Confirmed search and prompt texts only: what a runtime matches against. Capped. */
  servedMembers: string[];
  /** Asks assigned, any kind, ever. */
  asks: number;
  first_ts: number;
  usage: Record<string, number>;
  sources: Record<string, SourceSlice>;
  queryIntentId: string | null;
  /** The level-1 node it sat under when loaded; null or absent for a new cluster. Written only when it changes. */
  parentId?: string | null;
  /** Set when this fold changed it; only dirty clusters are written back. */
  dirty?: boolean;
}

/** One ask (or one part of a split ask) placed in a cluster. */
export interface EngineAssignment {
  eventId: string;
  /** 0 for a whole ask; the part or containment index otherwise. */
  askIndex: number;
  clusterUuid: string;
  kind: AskKind;
  /** The ask (or part) text. Not stored with the assignment; projected into Intents. */
  text: string;
  endUserId: string | null;
  sessionId: string | null;
  turnId: string | null;
  traceId: string | null;
  sourceId: string | null;
  at: number;
}

export interface EngineMerge {
  absorbedUuid: string;
  survivorUuid: string;
  /** The recurring-asks row (`query_intents`) the absorbed cluster was linked to, when it had one. */
  absorbedQueryIntentId?: string | null;
}

/** Everything the engine keeps for a project between folds. */
export interface EngineState {
  clusters: EngineCluster[];
  /** Next `intent_N` to hand out, merged graph and per-source alike. */
  nextGraphN: number;
}

/** A node above level 0. */
export interface LevelNode {
  uuid: string;
  level: number;
  /** uuids one level down. */
  children: string[];
  label: string;
  terms: string[];
}

export interface LevelTree {
  /** levels[0] is unused (level 0 is the clusters); levels[k] holds level k's nodes. */
  levels: LevelNode[][];
  /** child uuid (any level) -> parent uuid one level up. */
  parentOf: Map<string, string>;
}
