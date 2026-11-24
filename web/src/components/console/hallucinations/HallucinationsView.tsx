import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { ChartBarBig, CircleCheck, CircleDashed, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { HALLUCINATIONS_DESCRIPTION } from "@/components/console/hallucinations/copy";
import { GroupDonut } from "@/components/console/hallucinations/GroupDonut";
import { KindPanel } from "@/components/console/hallucinations/KindPanel";
import { KindTable } from "@/components/console/hallucinations/KindTable";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { percent, plural } from "@/components/console/sentiment/copy";
import { LinkSwitch, type LinkSwitchOption } from "@/components/console/settings/LinkSwitch";
import type { PanelTurn } from "@/components/console/turn-panel/useTurnPanel";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { agentHealthHref, windowPhrase } from "@/lib/readings/trace-signals/view";
import { formatRelativeTime, formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import { cleanResult } from "@/lib/views/health/hallucinations/clean";
import {
  type HallucinationsLinks,
  hallucinationsLinks,
} from "@/lib/views/health/hallucinations/page-links";
import type { HallucinationsPageModel } from "@/lib/views/health/hallucinations/page-model";
import { MAX_PAGE_FINDINGS } from "@/lib/views/health/hallucinations/page-queries";
import type { ToolNameCheck } from "@/lib/views/health/hallucinations/tool-names";

/**
 * Hallucinations (Agent health): what the agent made up, read from the trace
 * by rules. Top to bottom: three numbers (the share of turns with one, the
 * occurrences, the turns), the groups as a ring with their share of every
 * occurrence (a slice narrows the table and opens the group's kinds, a kind
 * narrows it further), and the kinds under each group, each opening in the
 * Panel with its tools and the calls in Traces.
 */
export function HallucinationsView({
  model,
  windows,
  now,
  turn = null,
}: {
  model: HallucinationsPageModel;
  /** The time windows the plan allows, as links. */
  windows: readonly LinkSwitchOption[];
  /** The request's time, so relative times match between server and client. */
  now: string;
  /** The turn the address opens in the Panel, with what Traces shows of it. */
  turn?: PanelTurn | null;
}) {
  return (
    <Page>
      <PageHeader
        title="Hallucinations"
        crumbs={[{ label: "Agent health", href: agentHealthHref(model.projectId) }]}
        description={HALLUCINATIONS_DESCRIPTION}
        actions={windows.length > 1 ? <LinkSwitch label="Time window" options={windows} /> : null}
      />
      <PageBody wide>
        <Body model={model} links={hallucinationsLinks(model)} now={now} turn={turn} />
      </PageBody>
    </Page>
  );
}

function Body({
  model,
  links,
  now,
  turn,
}: {
  model: HallucinationsPageModel;
  links: HallucinationsLinks;
  now: string;
  turn: PanelTurn | null;
}) {
  const span = windowPhrase(model.windowDays);
  const health = (
    <Link
      href={agentHealthHref(model.projectId)}
      className={buttonVariants({ variant: "secondary" })}
    >
      Open Agent health
    </Link>
  );
  if (model.state === "unavailable") {
    return (
      <Callout tone="danger" title="Couldn't load hallucinations">
        Try again in a moment. The rest of Agent health still works.
      </Callout>
    );
  }
  if (model.state === "not_read") {
    return (
      <EmptyState
        emblem
        title="Not read yet"
        description="Hallucinations show up after the next reading of your agent's runs."
        action={health}
      />
    );
  }
  if (model.state === "empty") {
    return (
      <EmptyState
        emblem
        title={`No turns ${span}`}
        description="Pick a longer window, or check that your agent is sending traces."
        action={health}
      />
    );
  }
  const { totals } = model;
  return (
    <>
      {/* Zeros over a window nothing could be read in would read as a result. */}
      {totals.occurrences === 0 &&
      model.groups.every((group) => group.unchecked !== null) ? null : (
        <StatRow
          stats={model.toolNames ? byNameHeadline(model, model.toolNames) : headline(model)}
        />
      )}
      {totals.occurrences === 0 ? (
        <NothingFound model={model} span={span} />
      ) : (
        <>
          <Section
            title={<NounTitle icon={ChartBarBig}>Groups</NounTitle>}
            description="Each group's share of every hallucination in this window. Point at a slice for its share. Pick a group to see its kinds, and a kind to narrow the table."
          >
            <GroupDonut links={links} total={totals.occurrences} />
          </Section>
          <Section
            title={<NounTitle icon={TriangleAlert}>Hallucinations by group</NounTitle>}
            description="Each group, then its kinds. Several failed tries in a row count once. Click a group to open it, a kind to see its tools and where it happened."
          >
            {/* A new filter is a new table, so a group listed alone starts open. */}
            <KindTable
              key={links.activeKind ?? links.activeGroup ?? "all"}
              groups={links.listed}
              now={now}
              empty={null}
            />
            <Footnotes model={model} now={now} />
          </Section>
          <KindPanel groups={links.listed} now={now} turn={turn} />
        </>
      )}
    </>
  );
}

/** No finding in the window (`cleanResult`): good news, large, where something was checked. */
function NothingFound({ model, span }: { model: HallucinationsPageModel; span: string }) {
  const result = cleanResult({
    groups: model.groups,
    toolNames: model.toolNames,
    turns: model.totals.turns,
    span,
  });
  if (result.state === "unchecked")
    return <EmptyState icon={CircleDashed} title={result.title} description={result.info} />;
  return (
    <div
      className="flex flex-col items-center gap-4 px-6 py-20 text-center"
      data-hallucination-result={result.state}
    >
      <CircleCheck className="size-14 text-success" strokeWidth={1.25} aria-hidden />
      <div className="flex flex-col gap-2">
        <p className="text-3xl font-semibold text-balance text-fg">{result.title}</p>
        <p className="text-sm text-fg-muted">{result.info}</p>
      </div>
    </div>
  );
}

/** A share that never rounds up to a whole it is not: 99.94% is 99.9%. */
const flooredPercent = (part: number, whole: number): string =>
  whole === 0
    ? "None"
    : part === whole
      ? "100%"
      : `${(Math.floor((part / whole) * 1000) / 10).toFixed(1)}%`;

/** The numbers of a window whose tools were checked by name. */
function byNameHeadline(model: HallucinationsPageModel, check: ToolNameCheck): StatProps[] {
  return [
    ...headline(model).slice(0, 2),
    {
      label: "Calls to a tool that works",
      value: flooredPercent(check.callsOnWorking, check.calls),
      hint: `${formatCount(check.callsOnWorking)} of ${plural(check.calls, "tool call")}`,
    },
  ];
}

/** Three numbers: the share of turns with a hallucination, how many there were, and the turns they sit in. */
function headline(model: HallucinationsPageModel): StatProps[] {
  const { totals } = model;
  const top = [...model.groups].sort((a, b) => b.occurrences - a.occurrences)[0];
  return [
    {
      label: "Hallucination rate",
      value:
        totals.rate === null
          ? "None"
          : totals.rate === 0
            ? "0%"
            : totals.rate > 0 && totals.rate < 0.001
              ? "<0.1%"
              : totals.rate < 0.1
                ? `${(totals.rate * 100).toFixed(1)}%`
                : percent(totals.rate),
      hint: `${formatCount(totals.turnsAffected)} of ${plural(totals.turns, "turn")} had at least one`,
    },
    {
      label: "Occurrences",
      value: formatCount(totals.occurrences),
      hint: "Several failed tries in a row count once",
    },
    {
      label: "Most common group",
      value: top && top.occurrences > 0 ? percent(top.share) : "None",
      hint:
        top && top.occurrences > 0
          ? hallucinationsLinks(model).groups.find((group) => group.group === top.group)!.label
          : "No hallucinations",
    },
  ];
}

/** Under the table: when it was last read, the cap, and how it was read. */
function Footnotes({ model, now }: { model: HallucinationsPageModel; now: string }) {
  return (
    <div className="flex flex-col gap-1 text-xs text-fg-subtle" data-hallucination-footnotes="">
      {model.lastReadAt ? (
        <p>
          Last read{" "}
          <time dateTime={model.lastReadAt} title={formatTimestamp(model.lastReadAt)}>
            {formatRelativeTime(model.lastReadAt, now)}
          </time>
          , with the last reading of your agent&apos;s runs.
        </p>
      ) : null}
      {model.aliases.length > 0 ? (
        <p data-hallucination-aliases="">
          Not counted, as names your runtime steadily maps to a tool:{" "}
          {model.aliases.map((alias, i) => (
            <span key={`${alias.requestedToolId}>${alias.toolId}`}>
              {i > 0 ? "; " : ""}
              <code className="font-mono">{alias.requestedToolId}</code> →{" "}
              <code className="font-mono">{alias.toolId}</code>
              {` (${formatCount(alias.calls)} calls in ${plural(alias.sessions, "session")}, ${formatCount(alias.worked)} worked)`}
            </span>
          ))}
          . Listing them in your catalog would make the names match.
        </p>
      ) : null}
      {model.capped ? (
        <p>
          This window held more than the newest {formatCount(MAX_PAGE_FINDINGS)} hallucinations.
          Pick a shorter window for exact counts.
        </p>
      ) : null}
      <p>
        Read from the trace by rules: the tool each call asked for, each failed call&apos;s error,
        and the agent&apos;s reply where it is sent. Where people&apos;s messages are read, a model
        also reads from the person&apos;s next message when work reported done was not.
      </p>
    </div>
  );
}
