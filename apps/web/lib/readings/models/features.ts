import type { ModelTier } from "@/lib/contracts/models";

/**
 * Every feature that calls a model, in one table (ADR-0033 §5). A feature's id is the name its
 * spend line carries. A text or chat feature asks for a tier; on Claude it keeps the default and
 * the variables it has always read (`variables`, first one set wins), and on another provider the
 * tier's variable names the model. A decision feature runs on the deployment's decision engine.
 *
 * A new feature is a row here. `features.test.ts` fails when a call names a feature that has none.
 */

export type FeatureKind = "text" | "chat" | "decision";

export interface FeatureRow {
  id: string;
  kind: FeatureKind;
  tier?: ModelTier;
  /** On Claude: the variables that name this feature's model, in the order they are read. */
  variables?: readonly string[];
  /** On Claude: the model when no variable is set. */
  claudeDefault?: string;
  /** What the feature does, for the docs. */
  does: string;
}

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-5-5";

export const FEATURES = [
  {
    id: "workflow_label",
    kind: "text",
    tier: "standard",
    variables: ["TRACE_WORKFLOW_LABEL_MODEL"],
    claudeDefault: SONNET,
    does: "Names a workflow found in Agent health",
  },
  {
    id: "intent_names",
    kind: "text",
    tier: "standard",
    variables: ["INTENT_ENGINE_NAME_MODEL", "TOPICS_LABEL_MODEL", "TRACE_WORKFLOW_LABEL_MODEL"],
    claudeDefault: SONNET,
    does: "Names the intent clusters",
  },
  {
    id: "topics_names",
    kind: "text",
    tier: "standard",
    variables: ["TOPICS_LABEL_MODEL", "TRACE_WORKFLOW_LABEL_MODEL"],
    claudeDefault: SONNET,
    does: "Names the topics people ask about",
  },
  {
    id: "match_quality_analyst",
    kind: "text",
    tier: "deep",
    variables: ["ANTHROPIC_MODEL"],
    claudeDefault: OPUS,
    does: "Reads a match-quality run and proposes fixes",
  },
  {
    id: "eval_gate_fix_draft",
    kind: "text",
    tier: "standard",
    variables: ["EVAL_GATE_DRAFT_MODEL"],
    claudeDefault: SONNET,
    does: "Drafts a fix for one finding",
  },
  {
    id: "eval_gate_replay",
    kind: "chat",
    tier: "deep",
    variables: ["EVAL_GATE_REPLAY_MODEL"],
    claudeDefault: OPUS,
    does: "Replays a recorded run with a fix applied",
  },
  {
    id: "eval_gate_what_if",
    kind: "chat",
    tier: "deep",
    variables: ["EVAL_GATE_REPLAY_MODEL"],
    claudeDefault: OPUS,
    does: "Replays a session with a What-if change",
  },
  {
    id: "eval_gate_stand_in",
    kind: "text",
    tier: "fast",
    variables: ["EVAL_GATE_JUDGE_MODEL"],
    claudeDefault: HAIKU,
    does: "Answers for a tool, and for the person, in a replay",
  },
  {
    id: "eval_gate_judge",
    kind: "text",
    tier: "fast",
    variables: ["EVAL_GATE_JUDGE_MODEL"],
    claudeDefault: HAIKU,
    does: "Judges a replayed run against its criteria",
  },
  {
    id: "eval_gate_task_judge",
    kind: "text",
    tier: "fast",
    variables: ["EVAL_GATE_JUDGE_MODEL"],
    claudeDefault: HAIKU,
    does: "Judges a live task run against its criteria",
  },
  {
    id: "eval_gate_task_test_draft",
    kind: "text",
    tier: "fast",
    variables: ["EVAL_GATE_JUDGE_MODEL"],
    claudeDefault: HAIKU,
    does: "Drafts a test from a run",
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

const BY_ID: ReadonlyMap<string, FeatureRow> = new Map(FEATURES.map((row) => [row.id, row]));

export function isFeature(id: string): id is FeatureId {
  return BY_ID.has(id);
}

/** A feature's row. Throws on an id that is not in the table: a call site named it wrong. */
export function featureRow(id: FeatureId): FeatureRow {
  const row = BY_ID.get(id);
  if (!row) throw new Error(`${id} is not in the feature table (lib/readings/models/features.ts)`);
  return row;
}
