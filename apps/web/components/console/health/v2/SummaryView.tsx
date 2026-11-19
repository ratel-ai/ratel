import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout } from "@ratel/design-system/states";
import type { ComponentType } from "react";
import { AnalysisStatus } from "@/components/console/freshness/AnalysisStatus";
import { pageGap, signalsForGap, tilesForGap } from "@/components/console/health/data-gaps-model";
import { RefreshWhileBuilding } from "@/components/console/health/RefreshWhileBuilding";
import { asksMissing, setupCardModel } from "@/components/console/health/setup-card-model";
import { CallOrderSection } from "@/components/console/health/v2/CallOrderSection";
import { GapBlock } from "@/components/console/health/v2/GapBlock";
import { HealthScore, type ScoreFix } from "@/components/console/health/v2/HealthScore";
import { HealthStateV2 } from "@/components/console/health/v2/HealthStateV2";
import { InferredToolsCallout } from "@/components/console/health/v2/InferredToolsCallout";
import { IssuesSection } from "@/components/console/health/v2/IssuesSection";
import { type IssueRow, issueRows, issuesLine } from "@/components/console/health/v2/issue-rows";
import { PartialReading } from "@/components/console/health/v2/PartialReading";
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
import type {
  HealthImporterProps,
  HealthShareLink,
  HealthShareProps,
} from "@/lib/contracts/composition";
import type { ImportSummary } from "@/lib/contracts/imported-runs";
import type { PartialReading as PartialReadingModel } from "@/lib/readings/trace-signals/partial-reading";
import {
  type HealthPageModel,
  runWindowLabel,
  type WindowOption,
} from "@/lib/readings/trace-signals/view";
import type { FixesModel } from "@/lib/views/fixes/types";
import { type HealthPageState, stateReadiness } from "@/lib/views/health/page-state";
import { earlyReadingCopy } from "@/lib/views/health/page-state-copy";
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
 * Owned (ADR-0030): no public share link or plan to pick. The sections that
 * upstream hands an upgrade link get none, so nothing is sold. The importer is
 * the edition's (`EditionUi.HealthImports`), absent without one.
 */

export interface SummaryImports {
  list: readonly ImportSummary[];
  contactUrl: string | null;
  sourceLabel: Readonly<Record<string, string>>;
  Importer: ComponentType<HealthImporterProps>;
}

export interface SummaryShare {
  link: HealthShareLink | null;
  canManage: boolean;
  Dialog: ComponentType<HealthShareProps>;
}

export interface SummaryViewProps {
  projectId: string;
  projectName: string;
  /** Already cut to the limits (`applyPlanLimits`); example turns are read on demand, not carried. */
  model: HealthPageModel;
  /** What the route decided is true for this window; null when the ledger could not be read. */
  state: HealthPageState | null;
  windowOptions: readonly WindowOption[];
  /** Where a plan can be picked (billing is self-serve); null names no plan and hides the links. */
  billingHref: string | null;
  /** The plan that shows every issue and its turns ("Plus"), named by the locks; null without plans. */
  lockedPlan?: string | null;
  /** Null when the task list could not be read. */
  tasks: TaskListModel | null;
  /** Null when Fixes could not be read: no issue then claims a fix. */
  fixes: Pick<FixesModel, "open" | "applied"> | null;
  corrections: SelfCorrectionsCardModel;
  /** The printable report for this window; null hides it. */
  reportHref: string | null;
  /** Null when the importer is off (no edition importer, or its read failed). */
  imports: SummaryImports | null;
  /** Null when sharing is not offered (no edition dialog, or its read failed). */
  share?: SummaryShare | null;
  /**
   * What the stored spans of imported runs with no tool calls say, drawn in
   * place of the `imported_no_tools` block. Null when the read failed.
   */
  partial?: PartialReadingModel | null;
  /**
   * The reading's tool calls were inferred
   * from the shape of imported spans and no content came with them.
   */
  inferredTools?: boolean;
  now?: Date;
}

export function SummaryView(props: SummaryViewProps) {
  const { projectId, projectName, model, imports } = props;
  const share = props.share ?? null;
  const state = summaryState(props.state, model);
  const ready = state.kind === "ready";
  const reading = ready && model.computedAt !== null;
  const canImport = imports !== null;
  const importer = (variant: "history" | "dialog") =>
    imports ? (
      <imports.Importer
        projectId={projectId}
        windowOptions={props.windowOptions}
        initialImports={imports.list}
        variant={variant}
        contactUrl={imports.contactUrl}
        readingBuilding={
          state.kind === "building" &&
          state.phase === "computing" &&
          state.working &&
          state.imported
        }
      />
    ) : null;
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
            {ready ? <AnalysisStatus projectId={projectId} section="health" /> : null}
            <WindowSwitch
              projectId={projectId}
              windowDays={model.windowDays}
              options={props.windowOptions}
            />
            <SummaryMenu
              reportHref={ready ? props.reportHref : null}
              canImport={ready && canImport}
              share={share ? { linkOn: share.link !== null } : null}
            />
            {share ? (
              <share.Dialog
                projectId={projectId}
                windowDays={model.windowDays}
                initialLink={share.link}
                canManage={share.canManage}
              />
            ) : null}
          </>
        }
      />
      <PageBody>
        <div
          className="flex flex-col gap-8"
          data-health-page-state={state.kind}
          data-health-readiness={stateReadiness(state)}
        >
          {ready ? (
            <Ready {...props} />
          ) : (
            <NotReady {...props} state={state} canImport={canImport} />
          )}
        </div>
        {ready ? importer("dialog") : importer("history")}
      </PageBody>
    </Page>
  );
}

/** Before a reading: the state block where the reading would be, then the readings as dashes while it fills. */
function NotReady({
  projectId,
  model,
  billingHref,
  state,
  canImport,
  imports,
  partial = null,
}: SummaryViewProps & { state: HealthPageState; canImport: boolean }) {
  const collecting = stateReadiness(state) === "collecting";
  return (
    <>
      {state.kind === "tool_spans" ? (
        <ToolSpansBlock />
      ) : state.kind === "ready" ? null : state.kind === "imported_no_tools" && partial ? (
        <PartialReading reading={partial} source={state.source} canImport={canImport} />
      ) : (
        <HealthStateV2
          projectId={projectId}
          state={state}
          windowDays={model.windowDays}
          canImport={canImport}
          billingHref={billingHref}
          sourceLabel={imports?.sourceLabel}
        />
      )}
      {collecting ? <Readings readings={readingViews(model.tiles)} interactive={false} /> : null}
    </>
  );
}

function Ready({
  projectId,
  model,
  state,
  tasks,
  fixes,
  corrections,
  billingHref,
  lockedPlan = null,
  imports,
  inferredTools = false,
}: SummaryViewProps) {
  const gap = pageGap(model);
  const lane = model.sourceMode === "otel" ? "otel" : "sdk";
  const runLabel = runWindowLabel(model);
  const card = setupCardModel(model.setup);
  const nudge: CaptureNudgeInput | null = model.setup
    ? null
    : { unlocks: model.captureUnlocks, captureLevel: model.captureLevel, mode: model.sourceMode };
  const signals = signalsForGap(model.signals, gap);
  const taskSteps = taskLookups(tasks, model.workflows);
  // A gap in the data hides the run-based issues, so a score over them would claim too much.
  const score = gap ? null : (model.score ?? null);
  const rows = issueRows({
    projectId,
    signals,
    tooEarly: model.tooEarly,
    folding: chainFolding(model.workflows),
    tasks: taskSteps,
    fixes: fixLookups(fixes),
    score,
  });
  const issues = (
    <IssuesSection
      projectId={projectId}
      rows={rows}
      line={issuesLine(rows, signals)}
      windowLabel={runLabel}
      examplesAllowed={model.evidenceTurnsPerSignal > 0}
      lockedCount={model.lockedCount}
      upgradeHref={billingHref}
      lockedPlan={lockedPlan}
      dismissed={model.dismissed ?? []}
      calculating={score && model.earlyReading ? { progress: model.earlyProgress ?? null } : null}
    />
  );
  const workflows = model.workflows;
  const asksLaneKey = lane === "otel" ? "otel_content" : "sdk_user_messages";
  // Inferred tool calls come without content: the asks say why they are empty, even with no task mined yet.
  const asksShowSetup =
    inferredTools || (!!workflows && workflows.items.length > 0 && asksMissing(model.setup));
  const asksSetupKey = asksShowSetup ? asksLaneKey : null;
  return (
    <>
      {state?.kind === "ready" && state.updating ? <RefreshWhileBuilding /> : null}
      {inferredTools ? <InferredToolsCallout /> : null}
      {score ? (
        <HealthScore
          score={score}
          next={scoreFixes(rows)}
          early={!!model.earlyReading}
          progress={model.earlyProgress ?? null}
          inferredTools={inferredTools}
        />
      ) : null}
      {/* With the score leading, its ring and the issues say "still calculating" without a paragraph. */}
      {model.earlyReading && !score ? (
        <EarlyReadingNotice
          signalWindowDays={model.signalWindowDays}
          importing={(imports?.list ?? []).some((item) => item.status === "running")}
          updating={state?.kind === "ready" && !!state.updating}
        />
      ) : null}
      {card || nudgeShown(nudge) ? (
        <SetupCallout projectId={projectId} card={card} nudge={nudge} />
      ) : null}
      <SetupGuidePanel
        projectId={projectId}
        card={card}
        nudge={nudge}
        captureLevel={model.captureLevel}
      />
      {/* With the score leading, what moves it comes right under it. */}
      {score ? issues : null}
      <Readings readings={readingViews(tilesForGap(model.tiles, gap))} />
      {gap ? null : <ShapesSection shapes={model.shapes} turns={model.turns} vocabulary={lane} />}
      {score ? null : issues}
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
              asksSetupKey={asksSetupKey}
              contentNotCaptured={inferredTools}
            />
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * An early reading's note (RC-224): this is a first look, still being
 * processed, and what the page shows will grow and may change.
 */
function EarlyReadingNotice(props: {
  signalWindowDays: number | null;
  importing: boolean;
  updating: boolean;
}) {
  const copy = earlyReadingCopy(props);
  return (
    <div data-health-early-reading={props.updating ? "updating" : "waiting"}>
      <Callout title={copy.title}>{copy.body}</Callout>
    </div>
  );
}

/** The three fixes worth the most points, as the score lists them; the rows already go most points first. */
function scoreFixes(rows: readonly IssueRow[]): ScoreFix[] {
  return rows
    .filter((row) => (row.points ?? 0) >= 1)
    .slice(0, 3)
    .map((row) => ({ peek: row.peek, title: row.title, kind: row.kind, points: row.points ?? 0 }));
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
