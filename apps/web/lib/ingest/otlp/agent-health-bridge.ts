import type { ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import type { TraceTurnsIngestDeps } from "@/lib/ingest/trace-events/turns-schedule";
import type { LogError } from "@/lib/platform/logger";
import { deriveModelCalls } from "./derive-model-calls";
import { deriveToolInvocations } from "./derive-tools";
import {
  type FindRuntimeInvokes,
  runtimeInvokeProbe,
  withoutRuntimeDuplicates,
} from "./runtime-duplicates";
import type { DecodedSpan } from "./types";

/**
 * The Agent health side of OTLP ingest: which rows an export adds to the turn
 * ledger (tool calls) and beside it (model round trips), which the Cloud-built
 * intent graph learns from too. A caller that wires no turn ledger (a test)
 * adds no rows.
 *
 * A project may send the Ratel SDK and OpenTelemetry side by side. Model-call
 * rows are always kept (the SDK never sends them). An OTel tool row is dropped
 * only when the SDK already recorded the same tool in the same session within
 * a few seconds (`runtime-duplicates.ts`), so one agent sending both is never
 * double counted while a second, OTel-only agent in the project keeps its runs.
 */

export interface AgentHealthBridgeDeps {
  traceTurns?: TraceTurnsIngestDeps;
  /** The project's SDK invokes near a batch's tool rows. Absent, nothing is dropped. */
  findRuntimeInvokes?: FindRuntimeInvokes;
  logError: LogError;
}

export async function agentHealthToolRows(
  spans: readonly DecodedSpan[],
  projectId: string,
  deps: AgentHealthBridgeDeps,
): Promise<ParsedTraceEvent[]> {
  if (!deps.traceTurns) return [];
  try {
    const rows = [...deriveToolInvocations(spans), ...deriveModelCalls(spans)];
    if (rows.length === 0) return [];
    return await withoutSdkDuplicates(rows, projectId, deps);
  } catch (err) {
    // Fail open to "no rows": the export's established result must not change.
    deps.logError("agent health tool derivation failed", err, { project_id: projectId });
    return [];
  }
}

/**
 * The rows minus the tool rows the SDK already recorded. Fails open: when the
 * read fails, every row is kept (logged), since dropping them would lose an
 * OTel-only agent's runs for good.
 */
async function withoutSdkDuplicates(
  rows: ParsedTraceEvent[],
  projectId: string,
  deps: AgentHealthBridgeDeps,
): Promise<ParsedTraceEvent[]> {
  const probe = runtimeInvokeProbe(rows);
  if (!probe || !deps.findRuntimeInvokes) return rows;
  try {
    return withoutRuntimeDuplicates(rows, await deps.findRuntimeInvokes(projectId, probe));
  } catch (err) {
    deps.logError("agent health sdk duplicate check failed", err, { project_id: projectId });
    return rows;
  }
}
