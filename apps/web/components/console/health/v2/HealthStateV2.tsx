import { buttonVariants } from "@ratel/design-system/button-variants";
import { DotEmblem, DotLoader, DotMeter } from "@ratel/design-system/dot-matrix";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { CalendarRange, KeyRound, Wrench } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { RefreshWhileBuilding } from "@/components/console/health/RefreshWhileBuilding";
import { OpenImportButtonV2 } from "@/components/console/health/v2/OpenImportButtonV2";
import { agentHealthHref, type WindowDays } from "@/lib/readings/trace-signals/view";
import type {
  BuildingPhase,
  HealthPageState,
  WindowSuggestion,
} from "@/lib/views/health/page-state";
import {
  healthStateCopy,
  type StateCopy,
  windowActionLabel,
} from "@/lib/views/health/page-state-copy";

/** The states this block draws: everything but the reading itself and the tool-spans notice. */
export type HealthStateV2State = Exclude<
  HealthPageState,
  { kind: "ready" } | { kind: "tool_spans" }
>;

export interface HealthStateV2Props {
  projectId: string;
  state: HealthStateV2State;
  windowDays: WindowDays;
  /** The importer is on the page, so "Import past runs" can open it. */
  canImport: boolean;
  /** The edition's names for import sources, by id. */
  sourceLabel?: Readonly<Record<string, string>>;
  now?: Date;
}

/**
 * The Agent health page before (or instead of) a reading, built from the design system: one
 * block in the place the reading would take, saying what is true for the selected window and
 * the one thing to do about it (DESIGN.md, Empty states). The words come from `healthStateCopy`.
 *
 * Owned (ADR-0030): no plan to pick; the importer is the edition's, and without it the one
 * action besides a wider window is the API key.
 */
export function HealthStateV2({
  projectId,
  state,
  windowDays,
  canImport,
  sourceLabel,
  now = new Date(),
}: HealthStateV2Props) {
  const copy = healthStateCopy(state, { windowDays, now, canImport, plans: false, sourceLabel });
  return (
    <section
      id="health-state"
      aria-label={copy.title}
      data-health-state={state.kind}
      className={
        state.kind === "unavailable" ? undefined : "rounded-lg border border-line bg-raised"
      }
    >
      <StateBody projectId={projectId} state={state} copy={copy} canImport={canImport} />
    </section>
  );
}

function StateBody({
  projectId,
  state,
  copy,
  canImport,
}: {
  projectId: string;
  state: HealthStateV2State;
  copy: StateCopy;
  canImport: boolean;
}) {
  const getKey = <ApiKeyLink projectId={projectId} primary={!canImport} />;
  const importRuns = canImport ? <OpenImportButtonV2 variant="primary" /> : null;
  switch (state.kind) {
    case "nothing_yet":
      return (
        <EmptyState
          emblem
          title={copy.title}
          description={copy.body}
          action={importRuns ?? getKey}
          secondary={importRuns ? getKey : undefined}
        />
      );
    case "building":
      return <Building phase={state.phase} copy={copy} />;
    case "imported_no_tools":
      return (
        <EmptyState
          icon={Wrench}
          title={copy.title}
          description={copy.body}
          action={importRuns ?? getKey}
          secondary={importRuns ? getKey : undefined}
        />
      );
    case "unavailable":
      // A failed section is one callout in its place (DESIGN.md, Errors), not a card in a card.
      return (
        <Callout tone="danger" title={copy.title}>
          {copy.body}
        </Callout>
      );
    case "too_few":
      return (
        <div
          className="flex flex-col items-center px-6 py-12 text-center"
          data-health-turns={state.turns}
        >
          <DotMeter
            value={state.turns / Math.max(1, state.floor)}
            label={`${state.turns} of ${state.floor} turns`}
            className="mb-4"
          />
          <p className="text-sm font-semibold tabular-nums text-fg">{copy.title}</p>
          <p className="mt-1 max-w-sm text-sm text-fg-muted">{copy.body}</p>
          <Actions>
            <WindowAction projectId={projectId} suggestion={state.wider} />
            {canImport && (
              <OpenImportButtonV2
                variant={state.wider && !state.wider.plan ? "secondary" : "primary"}
              />
            )}
          </Actions>
        </div>
      );
    case "outside_window":
      return (
        <EmptyState
          icon={CalendarRange}
          title={copy.title}
          description={copy.body}
          action={
            state.suggestion ? (
              <WindowAction projectId={projectId} suggestion={state.suggestion} />
            ) : (
              (importRuns ?? getKey)
            )
          }
          secondary={state.suggestion ? undefined : importRuns ? getKey : undefined}
        />
      );
  }
}

/**
 * Work in progress: the dot loader (a stalled reading, which waits on a retry, rests instead). A
 * reading being computed is watched for, so the page turns into it.
 */
function Building({ phase, copy }: { phase: BuildingPhase; copy: StateCopy }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center" data-health-building={phase}>
      {phase === "held" || phase === "stalled" ? (
        <DotEmblem className="mb-4" />
      ) : (
        <DotLoader className="mb-4" />
      )}
      <p className="text-sm font-semibold text-fg">{copy.title}</p>
      <p className="mt-1 max-w-sm text-sm text-fg-muted">{copy.body}</p>
      {phase === "computing" && <RefreshWhileBuilding />}
    </div>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-3 empty:hidden">
      {children}
    </div>
  );
}

/** "Show 30 days" for a wider window that has the turns; nothing when the limits exclude it. */
function WindowAction({
  projectId,
  suggestion,
}: {
  projectId: string;
  suggestion: WindowSuggestion | null;
}) {
  if (!suggestion || suggestion.plan) return null;
  return (
    <Link
      href={agentHealthHref(projectId, suggestion.days)}
      scroll={false}
      data-health-window-switch={suggestion.days}
      className={buttonVariants({ variant: "primary" })}
    >
      {windowActionLabel(suggestion.days)}
    </Link>
  );
}

function ApiKeyLink({ projectId, primary }: { projectId: string; primary: boolean }) {
  return (
    <Link
      href={`/project/${encodeURIComponent(projectId)}/settings/api-keys`}
      className={buttonVariants({ variant: primary ? "primary" : "secondary" })}
    >
      <KeyRound strokeWidth={1.5} aria-hidden />
      Get an API key
    </Link>
  );
}
