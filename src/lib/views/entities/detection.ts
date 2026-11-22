import { type SQL, sql } from "drizzle-orm";
import type { DetectSource } from "@/lib/ingest/otlp/dimensions/keys";

/**
 * How Ratel detected an entity (RC-779): from an explicit signal (the Ratel
 * SDK, an OpenTelemetry attribute) or by a guess. Ingest stores the source of
 * each span (`agent_source`, `mcp_server_source`, `harness_source`; RC-772,
 * RC-773). An entity whose spans mix sources reads as its weakest one.
 */

export type EntityKind = "agent" | "mcp-server" | "client";

/** The heuristic that named the entity. Each ingest rule in `lib/otlp/dimensions/` maps to one. */
export type DetectRule =
  /** agent.ts rule 5: the resource's `service.name` stands for the agent. */
  | "service-name"
  /** agent.ts rules 3 and 4: an `invoke_agent` or framework agent span name. */
  | "agent-span-name"
  /** mcp.ts: the server in a `server__tool` tool name. */
  | "tool-prefix"
  /** client.ts: the User-Agent product. */
  | "user-agent";

export interface Detection {
  source: DetectSource;
  /** Set for a heuristic source only. */
  rule: DetectRule | null;
}

export interface DetectionExplanation {
  label: string;
  tone: "warning" | "neutral";
  /** "from service.name". */
  rule: string;
  /** What to set to make a guess explicit; null for an explicit source. */
  fix: string | null;
}

const SOURCES: readonly DetectSource[] = ["heuristic", "semconv", "sdk"];

const RULES: Record<DetectRule, { rule: string; fix: string }> = {
  "service-name": {
    rule: "from service.name",
    fix: "Set gen_ai.agent.name on the agent's spans to name it explicitly.",
  },
  "agent-span-name": {
    rule: "from the agent span name",
    fix: "Set gen_ai.agent.name on the agent's spans to name it explicitly.",
  },
  "tool-prefix": {
    rule: "from the tool name prefix",
    fix: "Set ratel.upstream.server on the tool call span (the Ratel SDK sets it) to name the server explicitly.",
  },
  "user-agent": {
    rule: "from the User-Agent header",
    fix: "Set mcp.client.name on the server span, or export the session's initialize span with mcp.session.id.",
  },
};

const EXPLICIT: Record<Exclude<DetectSource, "heuristic">, DetectionExplanation> = {
  sdk: { label: "Ratel SDK", tone: "neutral", rule: "from the Ratel SDK", fix: null },
  semconv: {
    label: "OpenTelemetry",
    tone: "neutral",
    rule: "from an OpenTelemetry attribute",
    fix: null,
  },
};

/**
 * The entity's detection from its weakest stored source. `fromService` (agents
 * only): a heuristic span of the agent took its key from `service.name`.
 */
export function detectionOf(
  kind: EntityKind,
  source: string | null | undefined,
  { fromService = false } = {},
): Detection | null {
  if (!isDetectSource(source)) return null;
  if (source !== "heuristic") return { source, rule: null };
  return { source, rule: heuristicRule(kind, fromService) };
}

/** The words the marker shows, and its tooltip. */
export function explainDetection(detection: Detection): DetectionExplanation {
  if (detection.source !== "heuristic") return EXPLICIT[detection.source];
  const { rule, fix } = RULES[detection.rule ?? "service-name"];
  return { label: "Guessed", tone: "warning", rule, fix };
}

/** The weakest source of a group's spans: `heuristic` < `semconv` < `sdk`; null when no span has one. */
export function weakestSource(column: SQL): SQL<string | null> {
  const rank = sql.join(
    SOURCES.map((source, index) => sql.raw(`when '${source}' then ${index}`)),
    sql` `,
  );
  const back = sql.join(
    SOURCES.map((source, index) => sql.raw(`when ${index} then '${source}'`)),
    sql` `,
  );
  return sql<string | null>`(case min(case ${column} ${rank} end) ${back} end)`;
}

function heuristicRule(kind: EntityKind, fromService: boolean): DetectRule {
  if (kind === "mcp-server") return "tool-prefix";
  if (kind === "client") return "user-agent";
  return fromService ? "service-name" : "agent-span-name";
}

function isDetectSource(value: string | null | undefined): value is DetectSource {
  return SOURCES.includes(value as DetectSource);
}
