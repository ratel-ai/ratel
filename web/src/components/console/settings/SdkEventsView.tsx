import { buttonVariants } from "@ratel/design-system/button-variants";
import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { Callout } from "@ratel/design-system/states";
import Link from "next/link";
import { LinkSwitch } from "@/components/console/settings/LinkSwitch";
import { LoadError } from "@/components/console/settings/LoadError";
import { SdkEventsList } from "@/components/console/settings/SdkEventsList";
import {
  type DropView,
  type RejectView,
  SDK_EVENT_LIST_LIMIT,
  SDK_EVENT_WINDOWS,
  type SdkEventPayload,
  type SdkEventsState,
  type SdkEventsSummary,
  type SdkEventView,
  sdkEventsHref,
  summaryVerdict,
  windowLabel,
} from "@/lib/console/settings/sdk-events";
import { APP_NAME } from "@/lib/platform/app-config";
import { fmtCount } from "@/lib/platform/format";

export interface SdkEventsData {
  root: string;
  /** For loading a payload when its Panel opens. */
  projectId: string;
  /** Where the SDK is set up, for the first-run empty state. */
  setupHref: string;
  state: SdkEventsState;
  summary: SdkEventsSummary;
  /** Null when the list could not be read. */
  events: SdkEventView[] | null;
  pinned: SdkEventView | null;
  /** The payload of the event the URL opened, so a shared link shows it at once. */
  openPayload: SdkEventPayload | null;
  rejects: RejectView[] | null;
  drops: DropView[] | null;
  typeOptions: Array<{ value: string; label: string }>;
  sourceOptions: Array<{ value: string; label: string }>;
  /** False until any SDK event or source has ever been seen. */
  everReceived: boolean;
  now: string;
}

/**
 * Settings > Developer: first the plain answer (did the SDK's
 * events arrive in this window?), then the raw events with each one's
 * payload a click away. The window and every filter live in the URL.
 */
export function SdkEventsView({ data }: { data: SdkEventsData }) {
  const { root, state, summary } = data;
  const lostHref = sdkEventsHref(root, { ...state, tab: "dropped" });
  const verdict = summaryVerdict(summary);
  const counted =
    summary.received !== null && summary.dropped !== null && summary.rejected !== null;
  const listFailed =
    state.tab === "dropped" ? data.rejects === null || data.drops === null : data.events === null;

  const stats: StatProps[] = [
    {
      label: "Received",
      value: fmtCount(summary.received ?? 0),
      hint: receivedHint(state.range, summary.sources),
    },
    {
      label: "Dropped",
      value: fmtCount(summary.dropped ?? 0),
      hint: "Never sent by the SDK",
      href: summary.dropped ? lostHref : undefined,
    },
    {
      label: "Rejected",
      value: fmtCount(summary.rejected ?? 0),
      hint: `Refused by ${APP_NAME}`,
      href: summary.rejected ? lostHref : undefined,
    },
  ];

  return (
    <PageBody wide className="*:min-w-0">
      <Section
        title="SDK events"
        description="What the Ratel SDK in your agent reported, as it arrived."
        actions={
          <LinkSwitch
            label="Time window"
            options={SDK_EVENT_WINDOWS.map((option) => ({
              href: sdkEventsHref(root, { ...state, range: option.value }),
              label: option.label,
              active: option.value === state.range,
            }))}
          />
        }
      >
        {counted ? <StatRow stats={stats} /> : <LoadError what="the event counts" />}
      </Section>

      {verdict && verdict.tone !== "success" ? (
        <Callout
          tone={verdict.tone}
          action={
            state.tab === "dropped" ? null : (
              <Link
                href={lostHref}
                scroll={false}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                See what was lost
              </Link>
            )
          }
        >
          {verdict.text}
        </Callout>
      ) : null}

      <Section
        title={state.tab === "dropped" ? "Dropped and rejected" : "Events"}
        actions={
          <LinkSwitch
            label="View"
            options={[
              {
                href: sdkEventsHref(root, { ...state, tab: "events" }),
                label: "Events",
                active: state.tab === "events",
              },
              { href: lostHref, label: "Dropped and rejected", active: state.tab === "dropped" },
            ]}
          />
        }
      >
        {listFailed ? (
          <LoadError what="SDK events" />
        ) : (
          <SdkEventsList
            root={root}
            projectId={data.projectId}
            state={state}
            typeOptions={data.typeOptions}
            sourceOptions={data.sourceOptions}
            listMeta={
              state.tab === "events" && data.events && data.events.length > 0 ? (
                <span className="text-xs text-fg-subtle tabular-nums">
                  {listedLabel(data.events.length)}
                </span>
              ) : null
            }
            events={data.events ?? []}
            pinned={data.pinned}
            openPayload={data.openPayload}
            rejects={data.rejects ?? []}
            drops={data.drops ?? []}
            now={data.now}
            empty={emptyCopy(data)}
          />
        )}
      </Section>
    </PageBody>
  );
}

/** "Last 7 days, 2 sources active": the window, and how many SDKs reported this week. */
export function receivedHint(range: SdkEventsState["range"], activeSources: number): string {
  if (activeSources === 0) return windowLabel(range);
  return `${windowLabel(range)}, ${activeSources} ${activeSources === 1 ? "source" : "sources"} active`;
}

/** The list shows the newest events only; say so when it is full. */
export function listedLabel(count: number): string {
  return count >= SDK_EVENT_LIST_LIMIT
    ? `Newest ${SDK_EVENT_LIST_LIMIT}`
    : `${count} ${count === 1 ? "event" : "events"}`;
}

function emptyCopy(data: SdkEventsData) {
  const { root, state } = data;
  if (!data.everReceived) {
    return {
      title: "No SDK events yet",
      description:
        "When your agent runs with the Ratel SDK, its searches and tool calls show up here.",
      action: (
        <Link
          href={data.setupHref}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          Set up the SDK
        </Link>
      ),
    };
  }
  if (state.type || state.sourceId) {
    return {
      title: "No events match",
      description: "Clear the filters to see every event in this window.",
      action: (
        <Link
          href={sdkEventsHref(root, { ...state, type: "", sourceId: "" })}
          scroll={false}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          Clear filters
        </Link>
      ),
    };
  }
  return {
    title: "No SDK events in this window",
    description:
      state.range === "30d" ? "Nothing arrived in the last 30 days." : "Try a longer window.",
    action:
      state.range === "30d" ? undefined : (
        <Link
          href={sdkEventsHref(root, { ...state, range: "30d" })}
          scroll={false}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          Last 30 days
        </Link>
      ),
  };
}
