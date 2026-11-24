import { FocusedGap } from "@/components/console/health/focused/FocusedGap";
import { FocusedScore } from "@/components/console/health/focused/FocusedScore";
import { IssueCategories } from "@/components/console/health/focused/IssueCategories";
import {
  LeadingCallouts,
  readyReading,
  SummaryView,
  type SummaryViewProps,
  TrailingCallouts,
} from "@/components/console/health/v2/SummaryView";
import { issueCategories } from "@/lib/views/health/issue-categories";

/**
 * Agent health with `focusedConsole`: the Health score, and what costs its points, in the four
 * categories the score counts by. The header, the states before a reading and the notices about
 * the data are the Summary's.
 */
export function FocusedHealthView(props: Omit<SummaryViewProps, "corrections">) {
  const summary = { ...props, corrections: null };
  return <SummaryView {...summary} content={<FocusedReading {...summary} />} />;
}

function FocusedReading(props: SummaryViewProps) {
  const { projectId, model, state, imports, inferredTools, billingHref, lockedPlan = null } = props;
  const { gap, lane, runLabel, rows, score, line } = readyReading(props);
  const progress = model.earlyProgress ?? null;
  return (
    <>
      <LeadingCallouts
        state={state}
        model={model}
        imports={imports}
        inferredTools={inferredTools}
      />
      {score ? (
        <FocusedScore score={score} early={!!model.earlyReading} progress={progress} />
      ) : gap ? (
        <FocusedGap gap={gap} lane={lane} />
      ) : null}
      <TrailingCallouts
        projectId={projectId}
        state={state}
        model={model}
        imports={imports}
        score={score}
      />
      <IssueCategories
        projectId={projectId}
        categories={issueCategories(rows, score)}
        // Without a score, what a plan or a gap hides could be in any category.
        complete={score !== null || (model.lockedCount === 0 && gap === null)}
        line={line}
        windowLabel={runLabel}
        examplesAllowed={model.evidenceTurnsPerSignal > 0}
        lockedCount={model.lockedCount}
        upgradeHref={billingHref}
        lockedPlan={lockedPlan}
        dismissed={model.dismissed ?? []}
        calculating={score && model.earlyReading ? { progress } : null}
      />
    </>
  );
}
