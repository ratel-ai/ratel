import type { ClaimPart, ClaimTemplate } from "@/lib/readings/trace-signals/claims";
import { formatSharePercent } from "@/lib/readings/trace-signals/claims";
import { type FixPattern, fixLine } from "@/lib/readings/trace-signals/self-corrections/kinds";
import type { SubjectChip } from "@/lib/readings/trace-signals/view";

/**
 * The `self_correcting` kind's claim template, kind label, row title and
 * figure caption, spread into the maps of `claims.ts` the way the workflow
 * kinds are. Only function declarations are imported from `claims.ts`, so the
 * import cycle is safe at load time.
 */

export interface SelfCorrectionClaimFacts {
  self_correcting: {
    /** The tool, for a per-tool issue; null for a task's. */
    tool: SubjectChip | null;
    /** The task's display name, for a per-task issue; null for a tool's. */
    task: string | null;
    share: number;
    pattern: FixPattern;
    /** The tool the fix names; the subject tool for a per-tool issue. */
    fixTool: string | null;
    /** The topic the unanswered fix names. */
    topic: string | null;
  };
}

export const SELF_CORRECTION_CLAIM_TEMPLATES: {
  readonly [K in keyof SelfCorrectionClaimFacts]: ClaimTemplate<K>;
} = {
  self_correcting: {
    claim: ({ tool, task, share }): ClaimPart[] =>
      tool
        ? [
            "The agent corrects itself after ",
            { chip: tool },
            ` in ${formatSharePercent(share)} of the turns that call it.`,
          ]
        : [
            `The agent corrects itself in ${formatSharePercent(share)} of runs of ${task ?? "this task"}.`,
          ],
    fix: ({ pattern, fixTool, topic, task }) =>
      fixLine(pattern, { tool: fixTool, topic: topic ?? task }),
  },
};

export const SELF_CORRECTION_KIND_LABELS: {
  readonly [K in keyof SelfCorrectionClaimFacts]: string;
} = {
  self_correcting: "Corrects itself often",
};

export const SELF_CORRECTION_KIND_TITLES: {
  readonly [K in keyof SelfCorrectionClaimFacts]: string;
} = {
  self_correcting: "Agent keeps correcting itself",
};

export const SELF_CORRECTION_FIGURE_CAPTIONS: {
  readonly [K in keyof SelfCorrectionClaimFacts]: string;
} = {
  self_correcting: "self-corrected",
};
