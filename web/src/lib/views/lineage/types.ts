/**
 * The lineage chain (RC-42 shared contract, owned by RC-45): every object on
 * the Monitor → Insights → Improve → Ship spine names the object it came
 * from, one step back.
 *
 *   Monitor   trace / metric
 *   Insights  insight      → source: trace | metric
 *   Improve   fix / experiment / eval → source: insight
 *   Ship      shipment     → source: fix | experiment
 *
 * `LineageRef` is the one shape for any of them, in the UI, the MCP tools and
 * the API. Keep it exactly as the contract says: RC-43 (MCP) and RC-46 (eval
 * gate) code against it. Client-safe: no server imports here.
 */

export type LineageStage = "monitor" | "insights" | "improve" | "ship";

export type LineageRef = {
  stage: LineageStage;
  kind: string;
  id: string;
  label?: string;
  href?: string;
};

/** The spine, in order. */
export const LINEAGE_STAGES: readonly LineageStage[] = ["monitor", "insights", "improve", "ship"];

/** The stage's name in the rail. */
export const STAGE_LABELS: Readonly<Record<LineageStage, string>> = {
  monitor: "Monitor",
  insights: "Insights",
  improve: "Improve",
  ship: "Ship",
};

/**
 * The kinds the spine knows, by stage. `kind` stays a string in `LineageRef`
 * so a later object (RC-53's releases) needs no contract change; these are the
 * ones `hrefFor` and the UI understand today.
 *
 * - `trace`: a run, by its trace id. `metric`: a reading, by its signal kind
 *   (`first_try`, `wasted_search`...) or a metric name.
 * - `insight`: an Agent health issue (`trace_signals.id`). `intent` and `task`
 *   are insights too (Intents, Agent health › Tasks).
 * - `fix`: a Fix by its id (`issue:<id>`, `craft:<id>`, `rewrite:<id>`,
 *   `intent:<id>`). `experiment`: a calibration by its name. `eval`: an eval
 *   set or run (RC-46).
 * - `shipment`: a change that went live: `rewrite:<id>` for an applied
 *   description rewrite, else the id whoever recorded it chose.
 */
export const LINEAGE_KINDS = {
  monitor: ["trace", "metric"],
  insights: ["insight", "intent", "task"],
  improve: ["fix", "experiment", "eval"],
  ship: ["shipment"],
} as const satisfies Record<LineageStage, readonly string[]>;

export type LineageKind = (typeof LINEAGE_KINDS)[LineageStage][number];

/** The noun a kind reads as in "From …" ("From trace 4f2a…"). */
export const KIND_NOUNS: Readonly<Record<string, string>> = {
  trace: "trace",
  metric: "metric",
  insight: "insight",
  intent: "intent",
  task: "task",
  fix: "fix",
  experiment: "experiment",
  eval: "eval",
  shipment: "shipment",
};

export function isLineageStage(value: unknown): value is LineageStage {
  return typeof value === "string" && (LINEAGE_STAGES as readonly string[]).includes(value);
}

/** The stage a known kind belongs to, or null for a kind the spine does not know. */
export function stageOfKind(kind: string): LineageStage | null {
  for (const stage of LINEAGE_STAGES) {
    if ((LINEAGE_KINDS[stage] as readonly string[]).includes(kind)) return stage;
  }
  return null;
}

/** The stage one step back, or null from Monitor. */
export function previousStage(stage: LineageStage): LineageStage | null {
  const index = LINEAGE_STAGES.indexOf(stage);
  return index > 0 ? LINEAGE_STAGES[index - 1] : null;
}

/** The stage one step on, or null after Ship. */
export function nextStage(stage: LineageStage): LineageStage | null {
  const index = LINEAGE_STAGES.indexOf(stage);
  return index >= 0 && index < LINEAGE_STAGES.length - 1 ? LINEAGE_STAGES[index + 1] : null;
}

/** A stored ref read back strictly: the shape, or null (RC-46 stores refs as jsonb). */
export function parseLineageRef(value: unknown): LineageRef | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    !isLineageStage(record.stage) ||
    typeof record.kind !== "string" ||
    typeof record.id !== "string"
  )
    return null;
  return {
    stage: record.stage,
    kind: record.kind,
    id: record.id,
    ...(typeof record.label === "string" ? { label: record.label } : {}),
    ...(typeof record.href === "string" ? { href: record.href } : {}),
  };
}
