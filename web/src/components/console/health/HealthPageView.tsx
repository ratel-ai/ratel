import type { ReactNode } from "react";
import { CaptureNudge } from "@/components/console/health/CaptureNudge";
import { CollectingState } from "@/components/console/health/CollectingState";
import { EntranceMotion } from "@/components/console/health/EntranceMotion";
import { HealthHeader } from "@/components/console/health/HealthHeader";
import { HealthReadings } from "@/components/console/health/HealthReadings";
import { RefreshWhileBuilding } from "@/components/console/health/RefreshWhileBuilding";
import { SectionPreview, WorkflowPreviewRows } from "@/components/console/health/SectionPreview";
import { SetupCard } from "@/components/console/health/SetupCard";
import { SignalList } from "@/components/console/health/SignalList";
import { asksMissing, setupCardModel } from "@/components/console/health/setup-card-model";
import { HealthSurfaceProvider } from "@/components/console/health/surface";
import { ToolFlowMap } from "@/components/console/health/ToolFlowMap";
import { ToolSpansMissing } from "@/components/console/health/ToolSpansMissing";
import { TurnShapes } from "@/components/console/health/TurnShapes";
import { HealthScore } from "@/components/console/health/v2/HealthScore";
import { WorkflowsView } from "@/components/console/health/WorkflowsView";
import { WorkflowFocusProvider } from "@/components/console/health/workflow-focus";
import {
  evidenceChipText,
  type HealthPageModel,
  healthReadiness,
  runWindowLabel,
  type WindowOption,
} from "@/lib/readings/trace-signals/view";
import { pageGap, signalsForGap, tilesForGap } from "@/lib/views/health/data-gaps-model";
import { MOCK_HEALTH_MODEL } from "@/lib/views/health/mock-fixture";
import { type HealthPageState, stateReadiness } from "@/lib/views/health/page-state";
import { sourceBadgeText } from "@/lib/views/health/source-mode";
import { chainFolding } from "@/lib/views/health/workflows-view";

export interface HealthPageViewProps {
  projectId: string;
  projectName: string;
  /** Already cut to the plan by `applyPlanLimits`. */
  model: HealthPageModel;
  windowOptions: readonly WindowOption[];
  /** Header buttons (Share, Download PDF, Import) on the member page. */
  actions?: ReactNode;
  /** Shown under the waiting state before a first reading: the import card. */
  beforeReading?: ReactNode;
  /**
   * Set on the public copy behind a share link: the model must already be
   * redacted (`publicHealthModel`), and the page drops every link into the
   * project, the setup notices and the window control.
   */
  shared?: { organizationName: string } | null;
  /**
   * What the page can truthfully say (`healthPageState`): the reading, or why
   * there is none for this window (nothing yet, being built, too few, outside
   * the window), decided with the turn ledger and the imports. Absent (the
   * shared page, a failed ledger read), the model's own readiness decides.
   */
  state?: HealthPageState | null;
  /**
   * The block drawn for a non-ready `state` in place of `CollectingState`:
   * the design-system block (`v2/HealthStateV2`) the member page passes.
   */
  stateView?: ReactNode;
  /** Where a plan with a longer window can be picked, for a window the plan does not include. */
  billingHref?: string | null;
}

/**
 * What to turn on for a better page: the setup card when the run stored its
 * setup facts (null when nothing is missing), else the capture nudge, as runs
 * stored before the facts always had.
 */
function SetupNotice({ projectId, model }: { projectId: string; model: HealthPageModel }) {
  if (model.setup) {
    const card = setupCardModel(model.setup);
    return card ? (
      <SetupCard projectId={projectId} model={card} captureLevel={model.captureLevel} />
    ) : null;
  }
  return (
    <CaptureNudge
      projectId={projectId}
      captureLevel={model.captureLevel}
      unlocks={model.captureUnlocks}
      mode={model.sourceMode}
    />
  );
}

/**
 * The whole page below the route: header, then the state the page is in
 * (`state` when the route decided one, else the model's readiness). With
 * nothing at all it is only the invitation to import or send traces; with
 * runs no reading counts yet, the reading being built; with runs elsewhere,
 * when they are from and the window that holds them; while collecting, the
 * meter above a band of dashes; after that, setup, band, shapes, workflows,
 * map and signals. A project that only sends OpenTelemetry gets the same page
 * with the band, shapes and nudge it can measure (`model.sourceMode`).
 *
 * Summary first, detail on click: header, what to turn on, the readings (one
 * quiet line that opens into the band), the run shapes, the workflows (one
 * line each), the map and the problem list.
 */
export function HealthPageView({
  projectId,
  projectName,
  model,
  windowOptions,
  actions = null,
  beforeReading = null,
  shared = null,
  state = null,
  stateView = null,
  billingHref = null,
}: HealthPageViewProps) {
  // A state is only decided for the member page; the shared copy keeps the model's own readiness.
  const decided = shared ? null : state;
  const readiness = decided ? stateReadiness(decided) : healthReadiness(model);
  // The header's evidence chip counts the reading, as it always has. Beside
  // the collecting meter it counts the meter's turns, and it is left out where
  // a decided state says this window has no runs, so the two never disagree.
  const chipTurns = decided?.kind === "too_few" ? decided.turns : model.turns;
  const counted = chipTurns > 0 && readiness !== "no_telemetry";
  // The band and shapes follow the window control; the map and the problem
  // list come from the latest run, so they name their own span when it differs.
  const runLabel = runWindowLabel(model);
  const lane = model.sourceMode === "otel" ? "otel" : "sdk";
  const gap = pageGap(model);
  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-7"
      data-health-readiness={readiness}
      data-health-page-state={decided?.kind}
      // The subtree EntranceMotion's gate applies to (HEALTH_PAGE_ATTRIBUTE).
      data-health-page="true"
    >
      <HealthSurfaceProvider surface={shared ? "shared" : "member"}>
        <EntranceMotion />
        <HealthHeader
          projectId={projectId}
          projectName={projectName}
          windowDays={model.windowDays}
          windowOptions={windowOptions}
          evidence={
            counted
              ? evidenceChipText({ turns: chipTurns, captureLevel: model.captureLevel })
              : null
          }
          source={counted ? sourceBadgeText(model.sourceMode) : null}
          actions={actions}
          shared={shared}
        />
        {readiness !== "ready" &&
          (shared ? (
            <SharedNotReady turns={model.turns} floor={model.floor} />
          ) : decided ? (
            decided.kind === "tool_spans" ? (
              <ToolSpansMissing />
            ) : (
              (stateView ?? (
                <CollectingState
                  projectId={projectId}
                  turns={model.turns}
                  floor={model.floor}
                  state={decided}
                  windowDays={model.windowDays}
                  canImport={beforeReading !== null}
                  billingHref={billingHref}
                />
              ))
            )
          ) : model.waitingOn === "tool_spans" ? (
            <ToolSpansMissing />
          ) : (
            <CollectingState projectId={projectId} turns={model.turns} floor={model.floor} />
          ))}
        {readiness !== "ready" && !shared && beforeReading}
        {readiness === "collecting" && <HealthReadings tiles={model.tiles} expandable={false} />}
        {readiness === "ready" && (
          <>
            {/* A reading of runs this one missed is on its way: the page turns into it on its own. */}
            {decided?.kind === "ready" && decided.updating && <RefreshWhileBuilding />}
            {!shared && <SetupNotice projectId={projectId} model={model} />}
            {/* The public link's score (RC-226): the same ring and parts, without the fixes a visitor cannot open. */}
            {shared && model.score && !gap ? <HealthScore score={model.score} shared /> : null}
            <HealthReadings tiles={tilesForGap(model.tiles, gap)} />
            {gap ? (
              // Shapes, workflows and the map all read runs with tool calls: one example and one message for the three.
              <SectionPreview reason={gap} lane={lane} flush>
                <div className="flex flex-col gap-7">
                  <TurnShapes
                    shapes={MOCK_HEALTH_MODEL.shapes}
                    turns={MOCK_HEALTH_MODEL.turns}
                    vocabulary={lane}
                  />
                  <section className="rounded-2xl border border-forest-300 bg-forest-600/40 p-4 sm:p-5">
                    <h2 className="font-display text-lg font-semibold text-cream">Tasks</h2>
                    <WorkflowPreviewRows />
                  </section>
                </div>
              </SectionPreview>
            ) : (
              <>
                <TurnShapes shapes={model.shapes} turns={model.turns} vocabulary={lane} />
                {/* One focus for the list and the map: a picked workflow filters the same map. */}
                <WorkflowFocusProvider projectId={projectId}>
                  {model.workflows && (
                    <WorkflowsView
                      projectId={projectId}
                      workflows={model.workflows}
                      focusable={model.flow.journey !== undefined}
                      lane={lane}
                      asksMissing={asksMissing(model.setup)}
                    />
                  )}
                  <ToolFlowMap
                    flow={model.flow}
                    windowLabel={runLabel}
                    turnSourceMix={model.turnSourceMix}
                  />
                </WorkflowFocusProvider>
              </>
            )}
            <SignalList
              projectId={projectId}
              signals={signalsForGap(model.signals, gap)}
              tooEarly={model.tooEarly}
              lockedCount={model.lockedCount}
              evidenceTurnsPerSignal={model.evidenceTurnsPerSignal}
              windowLabel={runLabel}
              folding={chainFolding(model.workflows)}
              shared={shared !== null}
              dismissed={model.dismissed}
            />
          </>
        )}
      </HealthSurfaceProvider>
    </div>
  );
}

/** A shared page before the first reading: what is happening, without setup steps meant for the team. */
function SharedNotReady({ turns, floor }: { turns: number; floor: number }) {
  return (
    <section
      data-health-state="shared_not_ready"
      className="card-enter rounded-2xl border border-dashed border-forest-300 bg-forest-600/20 px-6 py-10 text-center"
    >
      <h2 className="font-display text-xl font-semibold tracking-tight text-cream">
        No reading yet
      </h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-warm-muted">
        This agent has sent {turns.toLocaleString("en-US")} of the {floor.toLocaleString("en-US")}{" "}
        runs a first reading needs. This page fills in on its own once it has them.
      </p>
    </section>
  );
}
