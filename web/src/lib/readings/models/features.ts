import type { ModelTier } from "@/lib/contracts/models";

/**
 * Every feature that calls a model, in one table (ADR-0009 §5). A feature's id is the name its
 * spend line carries. A text or chat feature asks for a tier; on Claude it keeps the default and
 * the settings it has always read (`settings`, first one set wins); every vendor has a model per
 * tier (`vendors.ts`), and `config.ts` holds the order. A decision feature runs on the deployment's
 * decision vendor.
 *
 * A leaf: `config.ts` reads the ids to name a setting per feature. A new feature is a row here. `features.test.ts` fails when a call names a feature that has none.
 */

/** A setting that has always named a Claude model, by its path in `config.ts`. */
export type ClaudeModelSetting =
  | "models.analyst"
  | "models.traceWorkflowLabel"
  | "models.topicsLabel"
  | "models.intentEngineName"
  | "evalGate.draftModel"
  | "evalGate.replayModel"
  | "evalGate.judgeModel";

export type FeatureKind = "text" | "chat" | "decision";

export interface FeatureRow {
  id: string;
  kind: FeatureKind;
  tier?: ModelTier;
  /** On Claude: the settings that name this feature's model, in the order they are read. */
  settings?: readonly ClaudeModelSetting[];
  /** On Claude: the model when no setting is. */
  claudeDefault?: string;
  /** What the feature does, for the docs. */
  does: string;
  /**
   * Ratel's own check of the setup, not a feature: it runs on the model of the feature it checks,
   * has no setting of its own, is not listed with the features, and its calls change no feature's
   * status. Its calls carry its id, so their spend is not a feature's.
   */
  check?: true;
}

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-5-5";

export const FEATURES = [
  {
    id: "workflow_label",
    kind: "text",
    tier: "standard",
    settings: ["models.traceWorkflowLabel"],
    claudeDefault: SONNET,
    does: "Names a workflow found in Agent health",
  },
  {
    id: "intent_names",
    kind: "text",
    tier: "standard",
    settings: ["models.intentEngineName", "models.topicsLabel", "models.traceWorkflowLabel"],
    claudeDefault: SONNET,
    does: "Names the intent clusters",
  },
  {
    id: "topics_names",
    kind: "text",
    tier: "standard",
    settings: ["models.topicsLabel", "models.traceWorkflowLabel"],
    claudeDefault: SONNET,
    does: "Names the topics people ask about",
  },
  {
    id: "match_quality_analyst",
    kind: "text",
    tier: "deep",
    settings: ["models.analyst"],
    claudeDefault: OPUS,
    does: "Reads a match-quality run and proposes fixes",
  },
  {
    id: "eval_gate_fix_draft",
    kind: "text",
    tier: "standard",
    settings: ["evalGate.draftModel"],
    claudeDefault: SONNET,
    does: "Drafts a fix for one finding",
  },
  {
    id: "eval_gate_replay",
    kind: "chat",
    tier: "deep",
    settings: ["evalGate.replayModel"],
    claudeDefault: OPUS,
    does: "Replays a recorded run with a fix applied",
  },
  {
    id: "eval_gate_what_if",
    kind: "chat",
    tier: "deep",
    settings: ["evalGate.replayModel"],
    claudeDefault: OPUS,
    does: "Replays a session with a What-if change",
  },
  {
    id: "eval_gate_stand_in",
    kind: "text",
    tier: "fast",
    settings: ["evalGate.judgeModel"],
    claudeDefault: HAIKU,
    does: "Answers for a tool, and for the person, in a replay",
  },
  {
    id: "eval_gate_judge",
    kind: "text",
    tier: "fast",
    settings: ["evalGate.judgeModel"],
    claudeDefault: HAIKU,
    does: "Judges a replayed run against its criteria",
  },
  {
    id: "eval_gate_task_judge",
    kind: "text",
    tier: "fast",
    claudeDefault: HAIKU,
    does: "Judges a live task run against its criteria",
  },
  {
    id: "eval_gate_task_test_draft",
    kind: "text",
    tier: "fast",
    claudeDefault: HAIKU,
    does: "Drafts a test from a run",
  },
  {
    id: "model_check",
    kind: "text",
    tier: "fast",
    claudeDefault: HAIKU,
    check: true,
    does: "The Check now button of Organization settings > Models, for every kind of model",
  },
  { id: "decision", kind: "decision", does: "A closed-set choice with no surface of its own" },
  { id: "match_quality_judge", kind: "decision", does: "Judges which tool a query wanted" },
  { id: "workflow_decide", kind: "decision", does: "Decides what a workflow was for" },
  { id: "topics_place", kind: "decision", does: "Places an ask under a topic" },
  { id: "topics_sentiment", kind: "decision", does: "Reads how an ask was meant" },
] as const satisfies readonly FeatureRow[];

type Row = (typeof FEATURES)[number];

export type FeatureId = Row["id"];
export type TextFeatureId = Extract<Row, { kind: "text" }>["id"];
export type ChatFeatureId = Extract<Row, { kind: "chat" }>["id"];
export type DecisionFeatureId = Extract<Row, { kind: "decision" }>["id"];

/** The text and chat features, each with a model of its own and its own variable to name it. */
export const MODEL_FEATURES: readonly FeatureRow[] = (FEATURES as readonly FeatureRow[]).filter(
  (row) => row.kind !== "decision" && !row.check,
);

/** The variable that names one feature's model on any vendor. */
export function featureVariable(id: string): string {
  return `MODEL_FEATURE_${id.toUpperCase()}`;
}

const BY_ID: ReadonlyMap<string, FeatureRow> = new Map(FEATURES.map((row) => [row.id, row]));

export function isFeature(id: string): id is FeatureId {
  return BY_ID.has(id);
}

/** Whether these calls are the console's check of the setup, not a feature's. */
export function isCheck(id: string): boolean {
  return BY_ID.get(id)?.check === true;
}

/** A feature's row. Throws on an id that is not in the table: a call site named it wrong. */
export function featureRow(id: FeatureId): FeatureRow {
  const row = BY_ID.get(id);
  if (!row) throw new Error(`${id} is not in the feature table (lib/readings/models/features.ts)`);
  return row;
}
