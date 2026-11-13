import type { ClaimPart, ClaimTemplate } from "@/lib/readings/trace-signals/claims";
import { formatCount, formatSharePercent } from "@/lib/readings/trace-signals/claims";
import type { SubjectChip } from "@/lib/readings/trace-signals/view";

/**
 * The workflow kinds' claim templates, kind labels, row titles and figure
 * captions, spread into the maps of `claims.ts`. A workflow is a recurring
 * group of tools the agent runs for one request; `workflow` is its display
 * name (`workflows/name.ts`). Only function declarations are imported from
 * `claims.ts`, so the import cycle is safe at load time.
 */

export interface WorkflowClaimFacts {
  workflow_failing: { workflow: string; failedShare: number; step: SubjectChip | null };
  workflow_slow: { workflow: string; ratio: number; step: SubjectChip | null; stepShare: number };
  workflow_fixed_chain: { steps: readonly SubjectChip[]; share: number };
}

type WorkflowKind = keyof WorkflowClaimFacts;

function chips(steps: readonly SubjectChip[]): ClaimPart[] {
  return steps.flatMap((step, i): ClaimPart[] => [
    ...(i === 0 ? [] : [i === steps.length - 1 ? " and " : ", "]),
    { chip: step },
  ]);
}

export const WORKFLOW_CLAIM_TEMPLATES: { readonly [K in WorkflowKind]: ClaimTemplate<K> } = {
  workflow_failing: {
    claim: ({ workflow, failedShare, step }) => [
      `Runs of ${workflow} fail ${formatSharePercent(failedShare)} of the time`,
      ...(step ? [", most often at ", { chip: step }, "."] : ["."]),
    ],
    fix: ({ step }) =>
      step
        ? `Start with ${step.label}: most failed runs stop there.`
        : "Open the failed runs to see where they stop.",
  },
  workflow_slow: {
    claim: ({ workflow, ratio, step, stepShare }) => [
      `${workflow} takes ${formatCount(ratio)} times as long as your other tasks`,
      ...(step
        ? ["; ", { chip: step }, ` takes ${formatSharePercent(stepShare)} of its time.`]
        : ["."]),
    ],
    fix: ({ step }) =>
      step
        ? `Make ${step.label} faster first: it takes the most time in these runs.`
        : "Open the slowest runs to see where the time goes.",
  },
  workflow_fixed_chain: {
    claim: ({ steps, share }) => [
      "The agent runs ",
      ...chips(steps),
      ` in this order in ${formatSharePercent(share)} of the runs that use them all.`,
    ],
    fix: () => "Combine these steps into one tool, or write a skill that runs them in this order.",
  },
};

export const WORKFLOW_KIND_LABELS: { readonly [K in WorkflowKind]: string } = {
  workflow_failing: "Task often fails",
  workflow_slow: "Slow task",
  workflow_fixed_chain: "Same steps every time",
};

export const WORKFLOW_KIND_TITLES: { readonly [K in WorkflowKind]: string } = {
  workflow_failing: "Runs that fail partway",
  workflow_slow: "Runs that take too long",
  workflow_fixed_chain: "Steps that always run in order",
};

export const WORKFLOW_FIGURE_CAPTIONS: { readonly [K in WorkflowKind]: string } = {
  workflow_failing: "of runs fail",
  workflow_slow: "typical run",
  workflow_fixed_chain: "same order",
};
