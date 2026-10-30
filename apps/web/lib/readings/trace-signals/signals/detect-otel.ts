import { DEFAULT_FLOORS, type Floors } from "@/lib/readings/trace-signals/signals/catalog";
import {
  agentFailing,
  blockedActions,
  identicalRetries,
  systemTurnFailing,
  tokenHeavy,
  waitHeavy,
} from "@/lib/readings/trace-signals/signals/detect-friction";
import { longTurns } from "@/lib/readings/trace-signals/signals/detect-long-turn";
import { unknownTools, unusedTools } from "@/lib/readings/trace-signals/signals/detect-menu";
import {
  emptyResults,
  toolSwitches,
} from "@/lib/readings/trace-signals/signals/detect-tool-switch";
import type { OtelStats } from "@/lib/readings/trace-signals/signals/otel-accumulators";
import type { AnalysisContext, DetectionResult } from "@/lib/readings/trace-signals/signals/types";
import type { SignalKind } from "@/lib/readings/trace-signals/view";

/**
 * The OpenTelemetry signals: the ones a project sending only OTel spans can
 * get in place of the search-quality half (it has no Ratel search step to
 * read). Each reads OTLP-lane turns and the facts OTLP ingest recorded beside
 * them, so a project without OTel facts, or without OTel turns, measures
 * none of them and emits nothing; an SDK-only project's signals are exactly
 * what they were. SDK runs linked to OTel model calls (`linked-runs.ts`) add
 * to the two model-call kinds, `long_turn` and `unused_tool`, only.
 *
 * A kind is measured only when the run could have seen it: `empty_result`
 * needs captured results, `unused_tool` captured tool menus, `long_turn` and
 * `token_heavy` model-call spans, `identical_retry` captured arguments. An unmeasured kind's open signals are kept, not missed.
 */

const NOTHING: DetectionResult = { signals: [], measured: new Set() };

export function detectOtel(
  stats: OtelStats | null,
  context: AnalysisContext,
  floors: Floors = DEFAULT_FLOORS,
): DetectionResult {
  if (!stats || !context.otel || (stats.otlpTurns === 0 && stats.linkedTurns === 0)) return NOTHING;
  const toolLane = stats.otlpTurns > 0;
  const measured = new Set<SignalKind>(
    toolLane ? ["tool_switch", "unknown_tool", "blocked_action", "wait_heavy"] : [],
  );
  if (stats.capturedResults > 0) measured.add("empty_result");
  if (stats.menuTurns > 0) measured.add("unused_tool");
  if (stats.modelTurns > 0) measured.add("long_turn");
  if (toolLane && stats.argCalls > 0) measured.add("identical_retry");
  if (stats.tokenTurns > 0) measured.add("token_heavy");
  if (stats.started.system.turns > 0) measured.add("system_turn_failing");
  if (stats.agents.size > 1) measured.add("agent_failing");
  return {
    signals: [
      ...(toolLane ? toolSwitches(stats, floors) : []),
      ...(measured.has("empty_result") ? emptyResults(stats, floors) : []),
      ...(toolLane ? unknownTools(stats, floors) : []),
      ...(measured.has("unused_tool") ? unusedTools(stats, context, floors) : []),
      ...longTurns(stats, floors),
      ...(toolLane ? blockedActions(stats, floors) : []),
      ...(measured.has("identical_retry") ? identicalRetries(stats, floors) : []),
      ...(toolLane ? waitHeavy(stats, floors) : []),
      ...tokenHeavy(stats, floors),
      ...(measured.has("system_turn_failing") ? systemTurnFailing(stats, floors) : []),
      ...(measured.has("agent_failing") ? agentFailing(stats, floors) : []),
    ],
    measured,
  };
}
