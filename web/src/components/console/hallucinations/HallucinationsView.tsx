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
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { agentHealthHref, windowPhrase } from "@/lib/readings/trace-signals/view";
import { formatRelativeTime, formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import {
  type HallucinationsLinks,
  hallucinationsLinks,
} from "@/lib/views/health/hallucinations/page-links";
import type { HallucinationsPageModel } from "@/lib/views/health/hallucinations/page-model";
import { MAX_PAGE_FINDINGS } from "@/lib/views/health/hallucinations/page-queries";

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
}: {
  model: HallucinationsPageModel;
  /** The time windows the plan allows, as links. */
  windows: readonly LinkSwitchOption[];
  /** The request's time, so relative times match between server and client. */
  now: string;
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
        <Body model={model} links={hallucinationsLinks(model)} now={now} />
      </PageBody>
    </Page>
  );
}

function Body({
  model,
  links,
  now,
}: {
  model: HallucinationsPageModel;
  links: HallucinationsLinks;
  now: string;
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
      <StatRow stats={headline(model)} />
      {totals.occurrences === 0 ? (
        <NothingFound links={links} turns={totals.turns} span={span} />
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
          <KindPanel groups={links.listed} now={now} />
        </>
      )}
    </>
  );
}

/**
 * No finding in the window. It says so only for the groups that could be
 * checked: a group whose rules had nothing to read is named, with what the
 * project would need to send, instead of being counted as clean.
 */
function NothingFound({
  links,
  turns,
  span,
}: {
  links: HallucinationsLinks;
  turns: number;
  span: string;
}) {
  const unchecked = links.groups.filter((group) => group.unchecked !== null);
  const checked = links.groups.filter((group) => group.unchecked === null);
  if (unchecked.length === 0) {
    return (
      <EmptyState
        icon={CircleCheck}
        title={`No hallucinations found ${span}`}
        description={`In ${plural(turns, "turn")}, the agent asked for no tool that doesn't exist, sent nothing a tool called missing, and reported no work it hadn't done.`}
      />
    );
  }
  return (
    <EmptyState
      icon={CircleDashed}
      title={
        checked.length === 0
          ? `Nothing could be checked ${span}`
          : `No hallucinations found in what could be checked ${span}`
      }
      description={
        <span className="flex flex-col gap-2 text-left" data-hallucination-unchecked="">
          {checked.length > 0 ? (
            <span>{`Checked in ${plural(turns, "turn")}: ${checked.map((group) => group.label).join(", ")}. Nothing found.`}</span>
          ) : null}
          {unchecked.map((group) => (
            <span key={group.group}>
              <span className="font-medium text-fg">{`${group.label}: not checked.`}</span>{" "}
              {group.unchecked}
            </span>
          ))}
        </span>
      }
    />
  );
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
