import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout } from "@ratel/design-system/states";
import { pageGap, signalsForGap, tilesForGap } from "@/components/console/health/data-gaps-model";
import { RefreshWhileBuilding } from "@/components/console/health/RefreshWhileBuilding";
import { asksMissing, setupCardModel } from "@/components/console/health/setup-card-model";
import { CallOrderSection } from "@/components/console/health/v2/CallOrderSection";
import { GapBlock } from "@/components/console/health/v2/GapBlock";
import { HealthStateV2 } from "@/components/console/health/v2/HealthStateV2";
import { IssuesSection } from "@/components/console/health/v2/IssuesSection";
import { issueRows, issuesLine } from "@/components/console/health/v2/issue-rows";
import { Readings } from "@/components/console/health/v2/Readings";
import { readingViews } from "@/components/console/health/v2/reading-views";
import { SelfCorrectionsRow } from "@/components/console/health/v2/SelfCorrectionsRow";
import { SetupCallout } from "@/components/console/health/v2/SetupCallout";
import { SetupGuidePanel } from "@/components/console/health/v2/SetupGuidePanel";
import { ShapesSection } from "@/components/console/health/v2/ShapesSection";
import { SummaryMenu } from "@/components/console/health/v2/SummaryMenu";
import { type CaptureNudgeInput, nudgeShown } from "@/components/console/health/v2/setup-nudge";
import {
  fixLookups,
  SUMMARY_TITLE,
  summaryDescription,
  summaryState,
  taskLookups,
} from "@/components/console/health/v2/summary-model";
import { TasksNeedingLook } from "@/components/console/health/v2/TasksNeedingLook";
import { ToolSpansBlock } from "@/components/console/health/v2/ToolSpansBlock";
import { UnservedSection } from "@/components/console/health/v2/UnservedSection";
import { WindowSwitch } from "@/components/console/health/v2/WindowSwitch";
import {
  type HealthPageModel,
  runWindowLabel,
  type WindowOption,
} from "@/lib/readings/trace-signals/view";
import type { FixesModel } from "@/lib/views/fixes/types";
import { type HealthPageState, stateReadiness } from "@/lib/views/health/page-state";
import type { SelfCorrectionsCardModel } from "@/lib/views/health/self-corrections/card";
import { chainFolding } from "@/lib/views/health/workflows-view";
import type { TaskListModel } from "@/lib/views/tasks/model";

/**
 * Agent health's Summary, the hub of Agent health. One question above the
 * fold: what does my agent get wrong, and what do I do about it? Numbers,
 * pins and marks first, the sentences one click away: the readings, how
 * turns went (their shapes), the issues in one list worst first (each opens
 * its fix), self-corrections in a row of their own, the tasks that need a
 * look, the order tools are called in with the common chains that are tasks,
 * and the requests no task handles. Before there is a reading, one designed
 * state sits where the reading would.
 *
 * Owned (ADR-0030): no importer, public share link or plan to pick. The
 * sections that upstream hands an upgrade link get none, so nothing is sold.
 */

export interface SummaryViewProps {
  projectId: string;
  projectName: string;
  /** Already cut to the limits (`applyPlanLimits`); example turns are read on demand, not carried. */
  model: HealthPageModel;
  /** What the route decided is true for this window; null when the ledger could not be read. */
  state: HealthPageState | null;
  windowOptions: readonly WindowOption[];
  /** Null when the task list could not be read. */
  tasks: TaskListModel | null;
  /** Null when Fixes could not be read: no issue then claims a fix. */
  fixes: Pick<FixesModel, "open" | "applied"> | null;
  corrections: SelfCorrectionsCardModel;
  /** The printable report for this window; null hides it. */
  reportHref: string | null;
  now?: Date;
}

export function SummaryView(props: SummaryViewProps) {
  const { projectId, projectName, model } = props;
  const state = summaryState(props.state, model);
  const ready = state.kind === "ready";
  const reading = ready && model.computedAt !== null;
  return (
    <Page>
      <PageHeader
        title={SUMMARY_TITLE}
        description={summaryDescription({
          projectName,
          windowDays: model.windowDays,
          turns: model.turns,
          sourceMode: model.sourceMode,
          reading,
        })}
        actions={
          <>
            <WindowSwitch
              projectId={projectId}
              windowDays={model.windowDays}
              options={props.windowOptions}
            />
            <SummaryMenu reportHref={ready ? props.reportHref : null} />
          </>
        }
      />
      <PageBody>
        <div
          className="flex flex-col gap-8"
          data-health-page-state={state.kind}
          data-health-readiness={stateReadiness(state)}
        >
          {ready ? <Ready {...props} /> : <NotReady {...props} state={state} />}
        </div>
      </PageBody>
    </Page>
  );
}

/** Before a reading: the state block where the reading would be, then the readings as dashes while it fills. */
function NotReady({ projectId, model, state }: SummaryViewProps & { state: HealthPageState }) {
  const collecting = stateReadiness(state) === "collecting";
  return (
    <>
      {state.kind === "tool_spans" ? (
        <ToolSpansBlock />
      ) : state.kind === "ready" ? null : (
        <HealthStateV2 projectId={projectId} state={state} windowDays={model.windowDays} />
      )}
      {collecting ? <Readings readings={readingViews(model.tiles)} interactive={false} /> : null}
    </>
  );
}

function Ready({ projectId, model, state, tasks, fixes, corrections }: SummaryViewProps) {
  const gap = pageGap(model);
  const lane = model.sourceMode === "otel" ? "otel" : "sdk";
  const runLabel = runWindowLabel(model);
  const card = setupCardModel(model.setup);
  const nudge: CaptureNudgeInput | null = model.setup
    ? null
    : { unlocks: model.captureUnlocks, captureLevel: model.captureLevel, mode: model.sourceMode };
  const signals = signalsForGap(model.signals, gap);
  const taskSteps = taskLookups(tasks, model.workflows);
  const rows = issueRows({
    projectId,
    signals,
    tooEarly: model.tooEarly,
    folding: chainFolding(model.workflows),
    tasks: taskSteps,
    fixes: fixLookups(fixes),
  });
  const workflows = model.workflows;
  const asksKey = asksMissing(model.setup)
    ? lane === "otel"
      ? "otel_content"
      : "sdk_user_messages"
    : null;
  return (
    <>
      {state?.kind === "ready" && state.updating ? <RefreshWhileBuilding /> : null}
      {card || nudgeShown(nudge) ? (
        <SetupCallout projectId={projectId} card={card} nudge={nudge} />
      ) : null}
      <SetupGuidePanel
        projectId={projectId}
        card={card}
        nudge={nudge}
        captureLevel={model.captureLevel}
      />
      <Readings readings={readingViews(tilesForGap(model.tiles, gap))} />
      {gap ? null : <ShapesSection shapes={model.shapes} turns={model.turns} vocabulary={lane} />}
      <IssuesSection
        projectId={projectId}
        rows={rows}
        line={issuesLine(rows, signals)}
        windowLabel={runLabel}
        examplesAllowed={model.evidenceTurnsPerSignal > 0}
        lockedCount={model.lockedCount}
        upgradeHref={null}
        dismissed={model.dismissed ?? []}
      />
      <SelfCorrectionsRow model={corrections} />
      {gap ? (
        <GapBlock gap={gap} lane={lane} />
      ) : (
        <TasksNeedingLook projectId={projectId} tasks={tasks} />
      )}
      {gap ? null : (
        <>
          <CallOrderSection
            projectId={projectId}
            flow={model.flow}
            windowLabel={runLabel}
            turnSourceMix={model.turnSourceMix}
            sourceMode={model.sourceMode}
            tasks={taskSteps}
          />
          {workflows && !workflows.blocked ? (
            <UnservedSection
              projectId={projectId}
              asks={workflows.unserved}
              asksFrom={workflows.asksFrom}
              asksSetupKey={workflows.items.length > 0 ? asksKey : null}
            />
          ) : null}
        </>
      )}
    </>
  );
}

/** The page when no database is connected: the header and one notice. */
export function SummaryNoDatabase() {
  return (
    <Page>
      <PageHeader title={SUMMARY_TITLE} />
      <PageBody>
        <Callout title="No database connected yet">
          Agent health becomes available once setup finishes.
        </Callout>
      </PageBody>
    </Page>
  );
}
