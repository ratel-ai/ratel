import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout } from "@ratel/design-system/states";
import type { ComponentType, ReactNode } from "react";
import { AnalysisStatus } from "@/components/console/freshness/AnalysisStatus";
import { RefreshWhileBuilding } from "@/components/console/health/RefreshWhileBuilding";
import { setupCardModel } from "@/components/console/health/setup-card-model";
import { HealthStateV2 } from "@/components/console/health/v2/HealthStateV2";
import { InferredToolsCallout } from "@/components/console/health/v2/InferredToolsCallout";
import { OpenImportButtonV2 } from "@/components/console/health/v2/OpenImportButtonV2";
import { PartialReading } from "@/components/console/health/v2/PartialReading";
import { SetupCallout } from "@/components/console/health/v2/SetupCallout";
import { SetupGuidePanel } from "@/components/console/health/v2/SetupGuidePanel";
import { SummaryMenu } from "@/components/console/health/v2/SummaryMenu";
import { type CaptureNudgeInput, nudgeShown } from "@/components/console/health/v2/setup-nudge";
import {
  fixLookups,
  SUMMARY_TITLE,
  summaryDescription,
  summaryState,
  taskLookups,
} from "@/components/console/health/v2/summary-model";
import { ToolSpansBlock } from "@/components/console/health/v2/ToolSpansBlock";
import { WindowSwitch } from "@/components/console/health/v2/WindowSwitch";
import type {
  HealthImporterProps,
  HealthShareLink,
  HealthShareProps,
} from "@/lib/contracts/composition";
import type { ImportSummary } from "@/lib/contracts/imported-runs";
import type { HealthScoreView } from "@/lib/readings/trace-signals/health-score";
import type { PartialReading as PartialReadingModel } from "@/lib/readings/trace-signals/partial-reading";
import {
  type HealthPageModel,
  runWindowLabel,
  type WindowOption,
} from "@/lib/readings/trace-signals/view";
import type { FixesModel } from "@/lib/views/fixes/types";
import { pageGap, signalsForGap } from "@/lib/views/health/data-gaps-model";
import { issueRows, issuesLine } from "@/lib/views/health/issue-rows";
import { type HealthPageState, stateReadiness } from "@/lib/views/health/page-state";
import { earlyReadingCopy, lowConfidenceCopy } from "@/lib/views/health/page-state-copy";
import { chainFolding } from "@/lib/views/health/workflows-view";
import type { TaskListModel } from "@/lib/views/tasks/model";

/**
 * Agent health's page around its reading: the header, the designed state shown before there is a
 * reading, and the notices about the data. The reading itself is `content`.
 *
 * Owned (ADR-0004): no public share link or plan to pick. The sections that
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

export function SummaryView({
  content,
  ...props
}: SummaryViewProps & {
  /** Drawn once there is a reading. */
  content: ReactNode;
}) {
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
          {ready ? content : <NotReady {...props} state={state} canImport={canImport} />}
        </div>
        {ready ? importer("dialog") : importer("history")}
      </PageBody>
    </Page>
  );
}

/** Before a reading: the state block where the reading would be. */
function NotReady({
  projectId,
  model,
  billingHref,
  state,
  canImport,
  imports,
  partial = null,
}: SummaryViewProps & {
  state: HealthPageState;
  canImport: boolean;
}) {
  if (state.kind === "ready") return null;
  if (state.kind === "tool_spans") return <ToolSpansBlock />;
  if (state.kind === "imported_no_tools" && partial)
    return <PartialReading reading={partial} source={state.source} canImport={canImport} />;
  return (
    <HealthStateV2
      projectId={projectId}
      state={state}
      windowDays={model.windowDays}
      canImport={canImport}
      billingHref={billingHref}
      sourceLabel={imports?.sourceLabel}
    />
  );
}

/** What a ready reading's issues and score are drawn from. */
export function readyReading({
  projectId,
  model,
  tasks,
  fixes,
}: Pick<SummaryViewProps, "projectId" | "model" | "tasks" | "fixes">) {
  const gap = pageGap(model);
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
  return {
    gap,
    lane: model.sourceMode === "otel" ? ("otel" as const) : ("sdk" as const),
    runLabel: runWindowLabel(model),
    taskSteps,
    score,
    rows,
    line: issuesLine(rows, signals),
  };
}

/** What a reader must know before the score: inferred tool calls, a first look. */
export function LeadingCallouts({
  state,
  model,
  imports,
  inferredTools = false,
}: Pick<SummaryViewProps, "state" | "model" | "imports" | "inferredTools">) {
  return (
    <>
      {state?.kind === "ready" && state.updating ? <RefreshWhileBuilding /> : null}
      {inferredTools ? <InferredToolsCallout /> : null}
      {model.lowConfidence ? (
        <div data-health-low-confidence={model.lowConfidence.turns}>
          <Callout
            tone="warning"
            title={lowConfidenceCopy(model.lowConfidence)}
            action={imports ? <OpenImportButtonV2 /> : null}
          >
            Flows, tasks, the score and the numbers below are a first look. Import past runs to read
            more now.
          </Callout>
        </div>
      ) : null}
    </>
  );
}

/** Under the score: an early reading's note when no score says it, and what to set up to read more. */
export function TrailingCallouts({
  projectId,
  state,
  model,
  imports,
  score,
}: Pick<SummaryViewProps, "projectId" | "state" | "model" | "imports"> & {
  score: HealthScoreView | null;
}) {
  const card = setupCardModel(model.setup);
  const nudge: CaptureNudgeInput | null = model.setup
    ? null
    : { unlocks: model.captureUnlocks, captureLevel: model.captureLevel, mode: model.sourceMode };
  return (
    <>
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
