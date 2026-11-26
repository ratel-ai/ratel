"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { EmptyState } from "@ratel/design-system/states";
import { CalendarRange, SearchX } from "lucide-react";
import { TRACES_DOCS } from "@/lib/console/docs-links";
import { formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import { TURN_NOUN } from "@/lib/synthesis/traces/v2/run-noun";
import { emptyNoun, type TracesEmptyUnit } from "./empty-noun";

export type TracesEmptyKind = "no-telemetry" | "events-only" | "outside-window" | "filtered";

/**
 * The ways a Traces list can be empty with something sent (DESIGN.md, Empty
 * states): events but no traces, nothing in this window, or nothing matching
 * the filters. Each says what to do next, with one action. Nothing sent at all
 * ("no-telemetry") is `TracesNoTelemetry`, a Server Component that reads the
 * project's API key; the page passes it to the list as a slot.
 */
export function TracesEmpty({
  kind,
  unit,
  latestAt,
  onClearFilters,
  onWiden,
}: {
  kind: Exclude<TracesEmptyKind, "no-telemetry">;
  unit: TracesEmptyUnit;
  /** The newest retained record, for "nothing in this window". */
  latestAt?: string | null;
  onClearFilters?: () => void;
  /** Widen the window, when a wider preset exists. */
  onWiden?: { label: string; run: () => void };
}) {
  const runNoun = TURN_NOUN;
  const noun = emptyNoun(unit);
  switch (kind) {
    case "events-only":
      return (
        <EmptyState
          emblem
          title={`No ${noun} yet`}
          description={`Your SDK is sending events, but no traces. Turn on tracing to see each ${runNoun.lower} step by step.`}
          action={
            <a
              href={TRACES_DOCS}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "primary" })}
            >
              Set up tracing
            </a>
          }
        />
      );
    case "outside-window":
      return (
        <EmptyState
          icon={CalendarRange}
          title={`No ${noun} in this window`}
          description={
            latestAt
              ? `The latest one started ${formatTimestamp(latestAt)}.`
              : "Try a wider window."
          }
          action={
            onWiden ? (
              <Button variant="secondary" onClick={onWiden.run}>
                {onWiden.label}
              </Button>
            ) : undefined
          }
        />
      );
    case "filtered":
      return (
        <EmptyState
          icon={SearchX}
          title={`No ${noun} match`}
          description="Nothing in this window matches these filters."
          action={
            onClearFilters ? (
              <Button variant="secondary" onClick={onClearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      );
  }
}
