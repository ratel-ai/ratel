"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { EmptyState } from "@ratel/design-system/states";
import { CalendarRange, SearchX } from "lucide-react";
import Link from "next/link";
import { formatTimestamp } from "@/lib/synthesis/traces/v2/format";

export const TRACES_DOCS = "https://docs.ratel.sh/observability";

export type TracesEmptyKind = "no-telemetry" | "events-only" | "outside-window" | "filtered";

const NOUN = { runs: "runs", spans: "spans", logs: "logs" } as const;

/**
 * Every way a Traces list can be empty (DESIGN.md, Empty states): nothing
 * sent yet, events but no traces, nothing in this window, or nothing matching
 * the filters. Each says what to do next, with one action.
 */
export function TracesEmpty({
  kind,
  unit,
  projectId,
  latestAt,
  onClearFilters,
  onWiden,
}: {
  kind: TracesEmptyKind;
  unit: keyof typeof NOUN;
  projectId: string;
  /** The newest retained record, for "nothing in this window". */
  latestAt?: string | null;
  onClearFilters?: () => void;
  /** Widen the window, when a wider preset exists. */
  onWiden?: { label: string; run: () => void };
}) {
  const noun = NOUN[unit];
  const docs = (
    <a
      href={TRACES_DOCS}
      target="_blank"
      rel="noreferrer"
      className={buttonVariants({ variant: "ghost" })}
    >
      Read the docs
    </a>
  );
  switch (kind) {
    case "no-telemetry":
      return (
        <EmptyState
          emblem
          title={`No ${noun} yet`}
          description="Send your first trace with the SDK and it shows up here within seconds."
          action={
            <Link
              href={`/project/${encodeURIComponent(projectId)}/settings/api-keys`}
              className={buttonVariants({ variant: "primary" })}
            >
              Create API key
            </Link>
          }
          secondary={docs}
        />
      );
    case "events-only":
      return (
        <EmptyState
          emblem
          title={`No ${noun} yet`}
          description="Your SDK is sending events, but no traces. Turn on tracing to see each run step by step."
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
