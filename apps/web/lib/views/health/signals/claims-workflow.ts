import type { SignalKind } from "@/lib/readings/trace-signals/view";
import { workflowDisplayName } from "@/lib/readings/trace-signals/workflows/name";
import {
  type Ctx,
  count,
  duration,
  type KindCopy,
  num,
  type Part,
  pct,
  plural,
  share,
  shareText,
  waiting,
} from "@/lib/views/health/signals/claims-kit";

/**
 * Card copy for the workflow kinds (`workflows/detect.ts`): a workflow is a
 * recurring group of tools the agent runs for one request, named by
 * {@link workflowDisplayName}. Same house rules as `claims-model.ts`: whole
 * percents, plain words, no em dashes.
 */

type WorkflowKind = "workflow_failing" | "workflow_slow" | "workflow_fixed_chain";

const text = (m: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = m[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** "a, b and c" as chips, for the fixed chain's sentence. */
function chipList(ids: readonly string[]): Part[] {
  return ids.flatMap((id, i): Part[] => [
    ...(i === 0 ? [] : [i === ids.length - 1 ? " and " : ", "]),
    { chip: id },
  ]);
}

const nameOf = ({ r, name, labels }: Ctx): string =>
  workflowDisplayName({ id: r.subjectKey, typicalOrder: r.subjectIds }, name, labels);

function failing(c: Ctx): KindCopy {
  const { r, m, name, period } = c;
  const failed = num(m, "failedRuns");
  const runs = num(m, "runs", r.n);
  const step = text(m, "failingStep");
  return {
    parts: [
      `Runs of ${nameOf(c)} fail ${shareText(failed, runs, 1 - num(m, "completion"))} of the time`,
      ...(step ? [", most often at ", { chip: step }, "."] : ["."]),
    ],
    figure: share(
      1 - num(m, "completion"),
      `${count(failed)} of ${plural(runs, "run", "runs")}`,
      failed,
      runs,
    ),
    cost: `${plural(failed, "run", "runs")} ended on a failed step ${period}, so the request was never finished.`,
    fix: step
      ? `Start with ${name(step)}: most failed runs stop there. Show these runs to whoever owns it.`
      : "Open the failed runs to see where they stop.",
  };
}

function slow(c: Ctx): KindCopy {
  const { r, m, name, period } = c;
  const step = text(m, "slowestStep");
  const ratio = Math.max(1, Math.round(num(m, "ratio")));
  return {
    parts: [
      `${nameOf(c)} takes ${count(ratio)} times as long as your other tasks`,
      ...(step
        ? ["; ", { chip: step }, ` takes ${pct(num(m, "slowestStepShare"))} of its time.`]
        : ["."]),
    ],
    figure: {
      value: num(m, "medianMs"),
      unit: "ms",
      display: duration(num(m, "medianMs")),
      raw: `typical run, against ${duration(num(m, "baselineMs"))}`,
    },
    cost: `${waiting(r.impact)} over ${plural(r.n, "run", "runs")} ${period}.`,
    fix: step
      ? `Make ${name(step)} faster first: it takes the most time in these runs.`
      : "Open the slowest runs to see where the time goes.",
  };
}

function fixedChain({ r, m, period }: Ctx): KindCopy {
  const stable = num(m, "orderStableRuns", r.totalTurns);
  const runs = num(m, "orderRuns");
  const stability = num(m, "orderStability");
  return {
    parts: [
      "The agent runs ",
      ...chipList(r.subjectIds),
      ` in this order in ${shareText(stable, runs, stability)} of the runs that use them all.`,
    ],
    figure: share(
      stability,
      `${count(stable)} of ${plural(runs, "run", "runs")} in this order`,
      stable,
      runs,
    ),
    cost: `One tool for the whole sequence would save about ${plural(r.impact, "call", "calls")} ${period}.`,
    fix: "Combine these steps into one tool, or write a skill that runs them in this order.",
  };
}

export const WORKFLOW_COPY: Pick<Record<SignalKind, (c: Ctx) => KindCopy>, WorkflowKind> = {
  workflow_failing: failing,
  workflow_slow: slow,
  workflow_fixed_chain: fixedChain,
};
