"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useTransition } from "react";
import { SdkEventsFilters } from "@/components/console/settings/SdkEventsFilters";
import { SdkEventsTable } from "@/components/console/settings/SdkEventsTable";
import { UndeliveredEvents } from "@/components/console/settings/UndeliveredEvents";
import {
  type DropView,
  type RejectView,
  type SdkEventPayload,
  type SdkEventsState,
  type SdkEventView,
  sdkEventsHref,
} from "@/lib/console/settings/sdk-events";

/**
 * The list half of SDK events: the filters and, below them, either the
 * events or what was dropped and rejected. A filter change is a navigation;
 * while it runs the table shows its skeleton rows.
 */
export function SdkEventsList({
  root,
  projectId,
  state,
  typeOptions,
  sourceOptions,
  listMeta,
  events,
  pinned,
  openPayload,
  rejects,
  drops,
  now,
  empty,
}: {
  root: string;
  projectId: string;
  state: SdkEventsState;
  typeOptions: ReadonlyArray<{ value: string; label: string }>;
  sourceOptions: ReadonlyArray<{ value: string; label: string }>;
  /** A quiet count on the right of the filters. */
  listMeta?: ReactNode;
  events: readonly SdkEventView[];
  pinned: SdkEventView | null;
  openPayload: SdkEventPayload | null;
  rejects: readonly RejectView[];
  drops: readonly DropView[];
  now: string;
  empty: { title: string; description: string; action?: ReactNode };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function change(next: Partial<SdkEventsState>) {
    startTransition(() =>
      router.push(sdkEventsHref(root, { ...state, ...next }), { scroll: false }),
    );
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={pending || undefined}>
      <SdkEventsFilters
        state={state}
        typeOptions={typeOptions}
        sourceOptions={sourceOptions}
        onChange={change}
        end={listMeta}
      />
      {state.tab === "dropped" ? (
        <div className={pending ? "opacity-60 transition-opacity duration-120" : undefined}>
          <UndeliveredEvents rejects={rejects} drops={drops} now={now} />
        </div>
      ) : (
        <SdkEventsTable
          projectId={projectId}
          events={events}
          pinned={pinned}
          openPayload={openPayload}
          now={now}
          empty={empty}
          loading={pending}
        />
      )}
    </div>
  );
}
