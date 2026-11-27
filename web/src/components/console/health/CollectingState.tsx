import { cn } from "@ratel/design-system/cn";
import Link from "next/link";
import type { ReactNode } from "react";
import { SearchingBadger } from "@/components/console/badgers/honeybadgers";
import { OpenImportButton } from "@/components/console/health/imports/OpenImportButton";
import { buttonVariants } from "@/components/console/health/primitives/button";
import { RefreshWhileBuilding } from "@/components/console/health/RefreshWhileBuilding";
import { ApiKeyCta, FirstTraceLink } from "@/components/console/settings/ApiKeyCta";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import {
  agentHealthHref,
  DEFAULT_WINDOW_DAYS,
  type WindowDays,
} from "@/lib/readings/trace-signals/view";
import type {
  BuildingPhase,
  HealthPageState,
  WindowSuggestion,
} from "@/lib/views/health/page-state";
import {
  healthStateCopy,
  inProgressLine,
  type StateCopy,
  widerLine,
  windowActionLabel,
} from "@/lib/views/health/page-state-copy";

export interface CollectingStateProps {
  projectId: string;
  /** Closed turns so far; 0 renders the no-telemetry state. Ignored when `state` is given. */
  turns: number;
  /** Turns needed for a first reading. */
  floor: number;
  /**
   * What the page can truthfully say (`healthPageState`), from the reading,
   * the ledger and the imports. Absent, `turns` alone picks between the two
   * states, as before.
   */
  state?: HealthPageState | null;
  windowDays?: WindowDays;
  /** The importer is on the page, so "Import past runs" can open it. */
  canImport?: boolean;
  /** Where a plan with a longer window can be picked; null hides the link. */
  billingHref?: string | null;
  /** The project has a usable API key (`hasUsableApiKey`): not asked for another. */
  hasApiKey?: boolean;
  now?: Date;
}

/** Ticks on the collecting meter: one per tenth of the floor. */
const METER_TICKS = 10;

/**
 * A link drawn as the outline button beside it. Merged, so the outline's
 * border wins over the base's transparent one (as it does inside `Button`).
 */
const LINK_BUTTON = cn(buttonVariants({ variant: "outline", size: "sm" }));

/**
 * The states before a reading (the v1 page; `v2/HealthStateV2` draws them
 * with the design system).
 *
 * With nothing at all the page is only an invitation, drawn like the traces
 * empty state (badger, dashed well, a way forward: import or an API key).
 * With some turns but fewer than the floor it is a `role="meter"`:
 * "Collecting · 14 of 50 turns". Runs no reading counts yet read as the
 * reading being built; runs outside the window say when they are from and
 * offer the window that holds them.
 */
export function CollectingState({
  projectId,
  turns,
  floor,
  state = null,
  windowDays = DEFAULT_WINDOW_DAYS,
  canImport = false,
  billingHref = null,
  hasApiKey = false,
  now = new Date(),
}: CollectingStateProps) {
  if (!state)
    return turns <= 0 ? (
      <NoTelemetry projectId={projectId} hasApiKey={hasApiKey} floor={floor} />
    ) : (
      <Collecting turns={turns} floor={floor} />
    );
  // With billing off no plan can be picked, so none is named.
  const plans = billingHref !== null;
  const copy = healthStateCopy(state, { windowDays, now, canImport, plans });
  switch (state.kind) {
    case "ready":
    case "tool_spans":
      return null;
    case "nothing_yet":
      return (
        <NoTelemetry
          projectId={projectId}
          hasApiKey={hasApiKey}
          floor={floor}
          canImport={canImport}
        />
      );
    case "too_few": {
      // The meter counts finished turns; the ones in progress are said beside it.
      const note = [inProgressLine(state), widerLine(state.wider, plans)].filter(Boolean).join(" ");
      return (
        <Collecting turns={state.turns} floor={state.floor}>
          {note && <span className="text-[13px] text-warm-muted">{note}</span>}
          <WindowLink projectId={projectId} suggestion={state.wider} billingHref={billingHref} />
        </Collecting>
      );
    }
    case "building":
      return <Building copy={copy} phase={state.phase} refresh={state.phase === "computing"} />;
    case "imported_no_tools":
      return (
        <Notice state="imported_no_tools" copy={copy}>
          {canImport && <OpenImportButton />}
          <ApiKeyLinks projectId={projectId} hasApiKey={hasApiKey} />
        </Notice>
      );
    case "unavailable":
      return <Notice state="unavailable" copy={copy} role="alert" />;
    case "outside_window":
      return (
        <Notice state="outside_window" copy={copy}>
          {state.suggestion ? (
            <WindowLink
              projectId={projectId}
              suggestion={state.suggestion}
              billingHref={billingHref}
            />
          ) : (
            <>
              {canImport && <OpenImportButton />}
              <ApiKeyLinks projectId={projectId} hasApiKey={hasApiKey} />
            </>
          )}
        </Notice>
      );
  }
}

/** Create a key; or, with one, send the first trace with the key beside it. */
function ApiKeyLinks({ projectId, hasApiKey }: { projectId: string; hasApiKey: boolean }) {
  return (
    <>
      {hasApiKey && <FirstTraceLink icon className={LINK_BUTTON} />}
      <ApiKeyCta projectId={projectId} hasApiKey={hasApiKey} icon className={LINK_BUTTON} />
    </>
  );
}

function NoTelemetry({
  projectId,
  hasApiKey,
  floor,
  canImport = false,
}: {
  projectId: string;
  hasApiKey: boolean;
  floor: number;
  canImport?: boolean;
}) {
  return (
    <section
      data-health-state="no_telemetry"
      aria-labelledby="health-no-telemetry-title"
      className="card-enter relative overflow-hidden rounded-2xl border border-dashed border-forest-300 bg-forest-600/20 px-6 py-10 text-center sm:px-10"
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-forest-300 to-transparent"
        aria-hidden
      />
      <div className="relative mx-auto flex h-28 w-44 items-center justify-center">
        <div
          className="absolute inset-x-6 bottom-2 h-8 rounded-[50%] bg-coral/[0.06] blur-2xl"
          aria-hidden
        />
        <SearchingBadger className="relative h-full w-full object-contain text-cream-dim drop-shadow-[0_14px_28px_rgba(0,0,0,0.65)]" />
      </div>
      <div className="mt-4 font-mono text-[10px] uppercase tracking-[0.12em] text-coral">
        No turns yet
      </div>
      <h2
        id="health-no-telemetry-title"
        className="mt-2 font-display text-xl font-semibold tracking-tight text-cream"
      >
        Send traces to see how your agent is doing
      </h2>
      <p className="mx-auto mt-2 max-w-xl text-pretty text-sm leading-relaxed text-warm-muted">
        Connect your agent with a project API key. After {formatCount(floor)} turns this page shows
        what it gets right, where it takes detours, and which tools cause them.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {canImport && <OpenImportButton />}
        <ApiKeyLinks projectId={projectId} hasApiKey={hasApiKey} />
      </div>
    </section>
  );
}

function Collecting({
  turns,
  floor,
  children = null,
}: {
  turns: number;
  floor: number;
  children?: ReactNode;
}) {
  const target = Math.max(1, floor);
  const shown = Math.min(turns, target);
  const remaining = Math.max(0, target - shown);
  const percent = Math.round((shown / target) * 100);
  return (
    <section
      data-health-state="collecting"
      aria-label="Collecting the first reading"
      className="card-enter relative overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/40 p-5 sm:p-6"
    >
      <div className="pixel-grid pointer-events-none absolute inset-0 opacity-30" aria-hidden />
      <div
        role="meter"
        aria-label="Turns collected for the first reading"
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={shown}
        aria-valuetext={`${shown} of ${target} turns`}
        className="relative"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="flex items-center gap-2.5 text-sm font-medium text-cream">
            <PulseDot />
            Collecting · {formatCount(shown)} of {formatCount(target)} turns
          </p>
          <span className="font-mono text-[11px] tabular-nums text-warm-muted">{percent}%</span>
        </div>
        <div className="relative mt-3.5 h-1 w-full overflow-hidden rounded-full bg-forest-300/60">
          <div
            className="meter-grow h-full rounded-full bg-coral"
            style={{ width: `${percent}%` }}
          />
          {Array.from({ length: METER_TICKS - 1 }, (_, index) => (
            <span
              key={index}
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-canvas/80"
              style={{ left: `${((index + 1) * 100) / METER_TICKS}%` }}
            />
          ))}
        </div>
        <p className="mt-3 text-[12px] leading-5 text-warm-muted">
          {remaining === 1 ? "One more turn" : `${formatCount(remaining)} more turns`} until the
          first reading. Signals appear as soon as each one has enough turns behind it.
        </p>
      </div>
      {children && (
        <div className="relative mt-4 flex flex-wrap items-center gap-2 empty:hidden">
          {children}
        </div>
      )}
    </section>
  );
}

function PulseDot() {
  return (
    <span className="relative flex size-2" aria-hidden>
      <span className="absolute inline-flex size-full rounded-full bg-coral/60 motion-safe:animate-ping" />
      <span className="relative inline-flex size-2 rounded-full bg-coral" />
    </span>
  );
}

/** The reading is on its way: the collecting card's look, with what is being read. */
function Building({
  copy,
  phase,
  refresh,
}: {
  copy: StateCopy;
  phase: BuildingPhase;
  refresh: boolean;
}) {
  return (
    <section
      data-health-state="building"
      data-health-building={phase}
      aria-live="polite"
      aria-label={copy.title}
      className="card-enter relative overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/40 p-5 sm:p-6"
    >
      <div className="pixel-grid pointer-events-none absolute inset-0 opacity-30" aria-hidden />
      <div className="relative">
        <p className="flex items-center gap-2.5 text-sm font-medium text-cream">
          {/* Waiting on people (a held import) or on a retry (a stalled reading) is not live work. */}
          {phase !== "held" && phase !== "stalled" && <PulseDot />}
          {copy.title}
        </p>
        <p className="mt-2 text-[13px] leading-5 text-warm-muted">{copy.body}</p>
      </div>
      {refresh && <RefreshWhileBuilding />}
    </section>
  );
}

/** A plain notice in the empty well's look: a window with nothing in it, or a reading that did not load. */
function Notice({
  state,
  copy,
  role,
  children = null,
}: {
  state: string;
  copy: StateCopy;
  role?: "alert";
  children?: ReactNode;
}) {
  return (
    <section
      data-health-state={state}
      aria-labelledby="health-state-title"
      role={role}
      className="card-enter relative overflow-hidden rounded-2xl border border-dashed border-forest-300 bg-forest-600/20 px-6 py-10 text-center sm:px-10"
    >
      <h2
        id="health-state-title"
        className="font-display text-xl font-semibold tracking-tight text-cream"
      >
        {copy.title}
      </h2>
      <p className="mx-auto mt-2 max-w-xl text-pretty text-sm leading-relaxed text-warm-muted">
        {copy.body}
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2 empty:hidden">
        {children}
      </div>
    </section>
  );
}

/**
 * "Show 30 days" for a window the plan includes; "See plans" for one it does
 * not (the words beside it name the plan).
 */
function WindowLink({
  projectId,
  suggestion,
  billingHref,
}: {
  projectId: string;
  suggestion: WindowSuggestion | null;
  billingHref: string | null;
}) {
  if (!suggestion) return null;
  if (!suggestion.plan) {
    return (
      <Link
        href={agentHealthHref(projectId, suggestion.days)}
        scroll={false}
        data-health-window-switch={suggestion.days}
        className={LINK_BUTTON}
      >
        {windowActionLabel(suggestion.days)}
      </Link>
    );
  }
  if (!billingHref) return null;
  return (
    <Link href={billingHref} data-health-see-plans="true" className={LINK_BUTTON}>
      See plans
    </Link>
  );
}
