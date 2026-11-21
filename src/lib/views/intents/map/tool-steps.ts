import { getDb } from "@/lib/platform/db/client";
import {
  type BoundReadDb,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { listTransitions } from "@/lib/readings/tool-explorer/queries";
import { mapSeams } from "./seams";
import { MIN_STEPS, type ToolStep, toolStepsFromEdges } from "./tool-network";

/**
 * The Map's "came next" arrows as the tool explorer reads them. Loading this module fills
 * `mapSeams.loadToolSteps`, which `queries.ts` reads, so the Tools lens draws steps between
 * tools from the explorer's latest completed run (the pattern of `quality/fix-rewrites.ts`
 * filling `fixSeams.loadRewrites`). A view may import a reading; the reading never imports
 * the view.
 */

/** The most "came next" counts the Tools view reads, busiest first. */
export const TOOL_STEP_READ_LIMIT = 600;

/**
 * Which tool came right after which in one turn, from the tool explorer's latest completed
 * run (its `next` edges at turn scope), as steps between the tools in `keep` (the ones on
 * the map). One indexed read of the latest completed run, busiest counts first, under the
 * supplementary statement timeout. Tool ids only; no query text is read.
 */
export async function loadExplorerToolSteps(
  input: { projectId: string; keep: ReadonlySet<string> },
  db: BoundReadDb = getDb(),
): Promise<ToolStep[]> {
  const edges = await withStatementTimeout(
    (tx) =>
      listTransitions(
        input.projectId,
        {
          scope: "turn",
          kind: "next",
          subject: "tool",
          minN: MIN_STEPS,
          limit: TOOL_STEP_READ_LIMIT,
        },
        tx,
      ),
    { operation: "intent_graph_tool_steps", timeoutMs: supplementaryReadTimeoutMs(), db },
  );
  return toolStepsFromEdges(edges, input.keep);
}

mapSeams.loadToolSteps = loadExplorerToolSteps;
