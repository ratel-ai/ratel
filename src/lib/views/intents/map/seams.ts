import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import type { ToolStep } from "./tool-network";

/**
 * What the intent map reads from the tool explorer once it lands: which tool came right after
 * which in one turn, as steps between the tools on the map. Empty, the map draws no "came next"
 * arrows. Same pattern as `computeSeams` in the trace-signals reading.
 */
export interface MapSeams {
  loadToolSteps?: (
    input: { projectId: string; keep: ReadonlySet<string> },
    db: BoundReadDb,
  ) => Promise<ToolStep[]>;
}

export const mapSeams: MapSeams = {};
