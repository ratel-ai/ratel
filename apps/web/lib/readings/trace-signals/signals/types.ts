import type { StepDraft, TurnDraft, TurnEndedBy } from "@/lib/ledger/types";
import type { LinkedRunFact } from "@/lib/readings/trace-signals/signals/linked-runs";
import type { OtelFacts } from "@/lib/readings/trace-signals/signals/otel-facts";
import type {
  SignalFixRoute,
  SignalKind,
  SignalSubjectKind,
  TurnSourceMix,
} from "@/lib/readings/trace-signals/view";
import type { RunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";
import type { WorkflowCore } from "@/lib/readings/trace-signals/workflows/types";

/**
 * Shapes shared by the signal detectors, the compute job and the replay CLI.
 *
 * Detectors are pure functions over {@link SignalTurn}s: closed turns with their
 * steps. A stored ledger turn and a `replayTurns` draft both satisfy it (a draft
 * needs only an id), so the job and the Phase 0 replay run the same code.
 */

/** A closed turn as the detectors read it. `TurnDraft & { id }` satisfies it. */
export interface SignalTurn
  extends Pick<
    TurnDraft,
    | "sessionId"
    | "turnSource"
    | "lane"
    | "startedAt"
    | "endedAt"
    | "searchCount"
    | "invokeCount"
    | "errorCount"
    | "reSearchCount"
    | "abandoned"
    | "detour"
    | "firstTry"
  > {
  /** How the run ended (`gap`, `cap`, `next_turn`, `idle`); optional, only the workflow basis reads it. */
  endedBy?: TurnEndedBy | null;
  id: string;
  steps: readonly StepDraft[];
  /** The turn's hashed end user, when one was sent. Optional: detectors never need it. */
  endUserKey?: string | null;
  /**
   * The ledger's turn key; on the OTLP lane `otlp:<traceId>`, or
   * `otlp-run:<first event id>` for a session's run of one-call traces.
   * Optional: only the OTel signals read it.
   */
  turnKey?: string;
  /**
   * An SDK run's OpenTelemetry model calls, linked by session and time
   * (`linked-runs.ts`). Absent on OTLP-lane turns and on runs nothing linked to.
   */
  linked?: LinkedRunFact;
}

/** A catalog entry as the detectors need it: id, display name, searchable text. */
export interface CatalogEntryFact {
  kind: string;
  entryId: string;
  name: string;
  searchable: string;
}

/** One `tool_usage_counters` row, summed over sources. */
export interface UsageFact {
  toolId: string;
  calls: number;
  lastUsedAt: Date;
}

/** One intent-graph cluster's size, for `fragmented_intents`. */
export interface ClusterFact {
  memberCount: number;
}

/** What a run reads besides turns. */
export interface AnalysisContext {
  windowStart: Date;
  windowEnd: Date;
  /** Earliest closed turn in the ledger (its `ended_at`); null for an empty ledger. */
  ledgerStartedAt: Date | null;
  catalog: readonly CatalogEntryFact[];
  usage: readonly UsageFact[];
  /** Clusters of the project's largest intent graph; null when there is none. */
  clusters: readonly ClusterFact[] | null;
  /**
   * What OTLP ingest recorded beside the ledger (errors, empty results, model
   * round trips, tool menus). Absent or null on projects without OTel, and
   * then the OTel signals are not measured.
   */
  otel?: OtelFacts | null;
  /**
   * The workflows of the project's latest completed run (id and core tools),
   * so a workflow keeps its id when its core drifts by a tool. Absent or empty
   * on a first run.
   */
  previousWorkflows?: readonly WorkflowCore[];
  /**
   * Which runs the reading reads, decided from the window's run counts before
   * it starts (`run-basis.ts`). `exact` reads only runs with a turn id or a
   * trace. Absent: every run, and the workflows decide their own basis.
   */
  runBasis?: RunBasis;
}

/** The ingest lanes a signal's evidence came from. */
export type SignalLane = "runtime" | "otlp" | "mixed";

/** Sampled evidence a signal carries: turn ids and their offending events. */
export interface SignalEvidenceRef {
  /** At most `EVIDENCE_TURNS_STORED`, newest first. */
  turnIds: string[];
  /** Parallel to `turnIds`: the `trace_events` id of the offending step, or null. */
  traceEventIds: (string | null)[];
  /** How many turns support the signal in total. */
  totalTurns: number;
  turnSourceMix: TurnSourceMix;
}

/** A metric value a claim can be built from. Numbers, ids and flags only. */
export type MetricValue = number | string | boolean | null | readonly string[] | readonly number[];

/** One detector finding, ready to upsert into `trace_signals`. */
export interface DetectedSignal {
  kind: SignalKind;
  subjectKind: SignalSubjectKind;
  subjectKey: string;
  /** Catalog ids the claim names, in claim order. */
  subjectIds: readonly string[];
  /** Whether those ids are tools or skills. */
  entryKind: "tool" | "skill";
  lane: SignalLane;
  /** The Wilson bound the detector fired on, in [0, 1]. */
  severity: number;
  /** Waste count: turns times extra units. */
  impact: number;
  n: number;
  route: SignalFixRoute;
  metrics: Readonly<Record<string, MetricValue>>;
  evidence: SignalEvidenceRef;
  /**
   * Extra fields stored in `trace_signals.subject` beside `ids` and
   * `entryKind`, so a card can render without the run summary (a workflow's
   * core tools and typical order). Absent on every other kind.
   */
  subjectDetail?: Readonly<Record<string, MetricValue>>;
}

/** A detector's output: what it found, and which kinds it could measure at all. */
export interface DetectionResult {
  signals: readonly DetectedSignal[];
  /** Kinds this run measured. A signal of an unmeasured kind is never marked missed. */
  measured: ReadonlySet<SignalKind>;
}

/** The key a signal is upserted by, also how flow nodes point at signals. */
export function signalKey(signal: Pick<DetectedSignal, "kind" | "subjectKey">): string {
  return `${signal.kind}:${signal.subjectKey}`;
}
